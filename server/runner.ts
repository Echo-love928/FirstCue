import { randomUUID } from 'node:crypto';
import type { Account, Candidate, Evidence, Rule, Run, Signal, Source } from '../shared/types.js';
import { Store } from './db.js';
import { INTERVAL_MS, safeError } from './config.js';
import { Collector, ingest } from './sources.js';
import { Analyzer,creatorVideoFallback, type AnalysisResult } from './ai.js';
import { applyQuality, discoveryCandidate, evidenceKey, linkedUrls, mergeEvidence, officialUrl, selectCandidates } from './quality.js';
import { nonTwitterDiscovery, platformOf } from '../shared/discovery.js';
import { discoverySearches, xQueryFor } from './search.js';
import { currentSignal, expiredEvidence, FRESHNESS_MS } from '../shared/freshness.js';
import { expireContent } from './retention.js';
import { analysisFingerprint, matchesRule, needsAnalysis, ruleFingerprint } from '../shared/relevance.js';
import { hash } from './parse.js';
import { creatorVideoMatches,creatorVideoRule,withdrawExcludedMatches } from './relevance.js';
import { syncEvidenceMetadata } from './twitter-policy.js';

export interface AnalysisService { analyze(evidence: Evidence[], rules: Rule[], prior: Signal[]): Promise<AnalysisResult>; }
async function mapConcurrent<T,R>(items:T[],limit:number,task:(item:T)=>Promise<R>):Promise<R[]> {
  const results:R[]=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){const index=next++;results[index]=await task(items[index]);}
  }));
  return results;
}
export class Runner {
  constructor(public store: Store, public collector: Collector, public analyzer: AnalysisService) {}
  async scan(trigger = '定时检查'): Promise<Run | null> {
    const owner = randomUUID(); if (!this.store.lease('scan', owner, 120000)) return null;
    const renewal = setInterval(() => this.store.lease('scan', owner, 120000), 30000); renewal.unref();
    const started = Date.now();
    expireContent(this.store,started);
    const rules = this.store.list<Rule>('rules').filter(rule => rule.enabled && (trigger !== '定时检查' || Date.parse(rule.nextRunAt) <= started));
    if (!rules.length) { clearInterval(renewal); this.store.release('scan', owner); return null; }
    const run: Run = { id: randomUUID(), startedAt: new Date(started).toISOString(), finishedAt: null, status: 'running', trigger, ruleIds: rules.map(rule => rule.id), sources: [], analyzed: 0, newSignals: 0, message: '' };
    this.store.put('runs', run.id, run); this.store.put('state', 'lastScanStarted', started);
    for (const old of this.store.list<Run>('runs').filter(item => item.status === 'running' && item.id !== run.id)) this.store.put('runs', old.id, { ...old, status: 'failed', finishedAt: run.startedAt, message: '服务重启或租约失效后恢复；候选和检查点仍保留' });
    const settings = this.store.settings();
    const reviewRules=this.store.list<Rule>('rules').filter(rule=>rule.enabled);
    const awaiting=this.store.list<Signal>('events').filter(signal=>signal.status==='pending'&&currentSignal(signal,started)&&reviewRules.some(rule=>matchesRule(signal,rule)));
    const awaitingKeys=new Set(awaiting.flatMap(signal=>signal.evidence.map(evidenceKey)));
    const verificationReserve=awaiting.length?Math.max(1,Math.floor(settings.searchPerRunLimit*0.2)):0;
    const discoveryBudget=Math.max(1,settings.searchPerRunLimit-verificationReserve);
    const sources = this.store.list<Source>('sources'); const since = started - FRESHNESS_MS;
    const gathered: Evidence[] = []; let webRequests = 0;
    const failedEngines = new Set<string>();
    const collect = async (source: Source, task: () => ReturnType<Collector['rss']>, purpose: 'discovery' | 'verification' | 'metrics' = 'discovery', query?: string, ruleId?:string) => {
      run.sources=run.sources.filter(row=>!(row.sourceId===source.id && row.status==='standby'));
      try {
        const value = await task();const target=rules.find(rule=>rule.id===ruleId);
        const items=value.items.map(item=>target?{...item,discoveryRules:{...item.discoveryRules,[target.id]:ruleFingerprint(target)}}:item);
        gathered.push(...items); run.sources.push({ ...value.result, purpose, query: query || value.result.query,ruleId });
        // Persist source results before optional AI work, so the feed can show them immediately.
        for(const item of items)ingest(this.store,item);
        return items;
      } catch (error) {
        run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: 'failed', count: 0, message: safeError(error), purpose, query,ruleId });
        if (source.kind === 'web') failedEngines.add(source.id);
        return [];
      } finally { this.store.put('runs', run.id, run); }
    };
    const save = (item: Evidence) => {
      const old = this.store.get<Candidate>('candidates', item.id);
      this.store.put('candidates', item.id, { ...old, ...item, processedHash: item.quality?.decision === 'filtered' ? item.contentHash : old?.processedHash || null, attempts: old?.attempts || 0 });
    };
    try {
      const recheck = trigger === '重新核实';
      if (recheck) {
        const cached = this.store.list<Candidate>('candidates');
        for (const source of sources) run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: source.enabled ? 'cached' : 'disabled', count: source.enabled ? cached.filter(item => item.sourceId === source.id).length : 0, message: source.enabled ? '复用持久化候选，本次不重新请求采集来源' : '已暂停' });
      } else {
        const sourceCollection=Promise.all(sources.map(async source => {
          if (!source.enabled) { run.sources.push({ sourceId: source.id, name: source.name, kind: source.kind, status: 'disabled', count: 0, message: '已暂停' }); return; }
          if (source.kind === 'web') { run.sources.push({sourceId:source.id,name:source.name,kind:source.kind,status:'standby',count:0,message:'等待本轮独立发现或定向补证查询',purpose:'discovery'}); return; }
          if (source.kind === 'rss') {
            const first=gathered.length;
            await collect(source, () => source.format === 'page' ? this.collector.page(source, since) : this.collector.rss(source, since));
            for(const item of gathered.slice(first).filter(item=>item.sourceId === source.id && source.official && !item.publishedAt).slice(0,3)) {
              const enriched=await this.collector.enrich(item);const index=gathered.findIndex(value=>value.id===item.id);if(index>=0)gathered[index]=enriched;
            }
          }
          if (source.kind === 'x') {
            for (const account of this.store.list<Account>('accounts').filter(item => item.enabled).slice(0, 10)) await collect(source, async () => this.collector.x(source, '', since, await this.collector.resolveAccount(account)));
            for (const query of [...new Set(rules.map(rule=>xQueryFor(rule, Math.floor((this.store.get<number>('state','discoveryRotation')||0)/3))))]) {
              const before=run.sources.filter(row=>row.sourceId===source.id && row.status==='failed').length;
              const target=rules.find(rule=>xQueryFor(rule,Math.floor((this.store.get<number>('state','discoveryRotation')||0)/3))===query);
              await collect(source, () => this.collector.x(source, query, since),'discovery',query,target?.id);
              if(run.sources.filter(row=>row.sourceId===source.id && row.status==='failed').length>before)break;
            }
          }
        }));
        const rotation=this.store.get<number>('state','discoveryRotation')||0;
        const jobs=discoverySearches(rules,sources,discoveryBudget,rotation,started);
        this.store.put('state','discoveryRotation',rotation+1);
        let discoveryEngine=rotation;
        const blockedPlatforms=new Set<string>();const readKeys=new Set<string>();
        for(const job of jobs) {
          if(webRequests>=discoveryBudget)break;
          const engines=sources.filter(item=>item.enabled && item.kind==='web' && !item.format && !failedEngines.has(item.id)).sort((a,b)=>a.id.localeCompare(b.id));
          const engine=engines[discoveryEngine%engines.length];let found:Evidence[]=[];
          if(job.source.format==='bilibili' && !blockedPlatforms.has(job.source.id)) {
            webRequests++;found=await collect(job.source,()=>this.collector.videoSearch(job.source,job.query),'discovery',job.query,job.ruleId);
            if(run.sources.some(row=>row.ruleId===job.ruleId&&row.query===job.query&&row.status==='failed'))blockedPlatforms.add(job.source.id);
          } else if(engine) {
            webRequests++;discoveryEngine++;
            const query=job.source.format==='bilibili'?'site:bilibili.com/video '+job.query+' '+new Date(started).toISOString().slice(0,7):job.query;
            found=await collect(job.source.format?job.source:engine,()=>job.source.format?this.collector.platformSearch(job.source,engine,query):this.collector.web(engine,query),'discovery',query,job.ruleId);
            if(run.sources.some(row=>row.ruleId===job.ruleId&&row.query===query&&row.status==='failed'))failedEngines.add(engine.id);
          } else {run.sources.push({sourceId:job.source.id,name:job.source.name,kind:job.source.kind,status:'failed',count:0,message:'没有可用的公开搜索引擎，保留后续检查',purpose:'discovery',query:job.query});}
          await mapConcurrent(mergeEvidence(found).filter(item=>item.quality?.decision!=='filtered'&&!readKeys.has(evidenceKey(item))).slice(0,10),3,async item=>{
            readKeys.add(evidenceKey(item));
            const video=platformOf(item)==='bilibili';
            // Readable descriptions already establish a candidate; optional metrics
            // must not spend the search budget before remaining discovery jobs.
            const readVideo=video && !nonTwitterDiscovery(item,started) && webRequests<settings.searchPerRunLimit;
            let material=item;
            if(readVideo) {
              webRequests++;
              const details=await collect(job.source,async()=>this.collector.result(job.source,[await this.collector.videoDetails(item)],'success','已读取视频详情中的作者头像、转发与评论'),'metrics');
              material=details[0] || {...item,metricsAttemptedAt:new Date().toISOString()};
            } else if(!video && !nonTwitterDiscovery(item,started))material=await this.collector.enrich(item);
            const value=applyQuality(material);
            ingest(this.store,value);
            const index=gathered.findIndex(ev=>ev.id===value.id);if(index>=0)gathered[index]=value;else gathered.push(value);
          });
        }
        await sourceCollection;
        for(const source of sources.filter(item=>item.enabled && item.kind === 'x')) await collect(source,()=>this.collector.refreshMetrics(source),'metrics');
      }

      const unique = [...new Map(mergeEvidence(gathered).map(item => [item.id, item])).values()];
      for (const item of unique) ingest(this.store, item);
      if(!recheck)for(const source of sources.filter(item=>item.enabled && item.format==='bilibili')) {
        const limit=Math.min(2,settings.searchPerRunLimit-webRequests-Math.max(1,verificationReserve));if(limit<=0)break;
        await collect(source,()=>this.collector.refreshVideoMetrics(source,limit),'metrics');webRequests+=limit;
      }
      const all = this.store.list<Candidate>('candidates');
      const classified = all.map(item => {
        const value=applyQuality(item,all);
        const recovered=item.sourceKind==='x'&&item.quality?.decision==='filtered'&&value.quality?.decision==='eligible';
        return {...item,...value,...(recovered?{processedHash:null,attempts:0}:{})};
      });
      for (const item of classified) this.store.put('candidates', item.id, { ...item, processedHash: item.quality?.decision === 'filtered' ? item.contentHash : item.processedHash });
      syncEvidenceMetadata(this.store);
      const enabledSources = new Set(sources.filter(source => source.enabled).map(source => source.id));
      const disabledPlatforms=new Set(sources.filter(source=>!source.enabled && ['bilibili','weibo'].includes(source.format||'')).map(source=>source.id));
      const fingerprint=analysisFingerprint(reviewRules);
      for(const item of classified) if(item.analysisFingerprint!==fingerprint)item.attempts=0;
      const pending = classified.filter(item => !disabledPlatforms.has(platformOf(item)) && enabledSources.has(item.sourceId) && discoveryCandidate(item,started) && needsAnalysis(item,reviewRules) && (item.attempts < 3||awaitingKeys.has(evidenceKey(item))));
      const priority=selectCandidates(pending.filter(item=>awaitingKeys.has(evidenceKey(item))),Math.max(1,Math.floor(settings.candidatePerRunLimit*0.4)));
      const priorityKeys=new Set(priority.map(evidenceKey));
      const selected=[...priority,...selectCandidates(pending.filter(item=>!priorityKeys.has(evidenceKey(item))),settings.candidatePerRunLimit-priority.length)];

      const modelUnavailable=this.analyzer instanceof Analyzer&&(!this.analyzer.apiKey||!settings.model);
      const quotaExhausted=this.analyzer instanceof Analyzer&&(this.store.usage().aiRequests||0)>=settings.aiDailyLimit;
      if(selected.length&&(modelUnavailable||quotaExhausted)){
        // Metadata matches must not depend on the position of a video in paid AI batches.
        const works=pending.filter(item=>reviewRules.some(rule=>creatorVideoMatches(item,rule,started))).slice(0,settings.candidatePerRunLimit);
        for(let index=0;index<works.length;index+=8){
          const batch=works.slice(index,index+8),prior=this.store.list<Signal>('events');
          const result=creatorVideoFallback(batch,reviewRules,prior,started);
          if(!result)continue;
          this.store.transaction(()=>{
            for(const signal of result.signals){
              if(!this.store.get('events',signal.id)&&currentSignal(signal,started))run.newSignals++;
              this.store.put('events',signal.id,signal);
            }
            for(const item of batch){
              const saved=this.store.get<Candidate>('candidates',item.id)!;
              this.store.put('candidates',item.id,{...saved,processedHash:reviewRules.every(creatorVideoRule)?item.contentHash:null,analysisFingerprint:fingerprint,attempts:0});
            }
          });
          if(reviewRules.every(creatorVideoRule))run.analyzed+=batch.length;
        }
        run.message=modelUnavailable?'AI 尚未配置：已保存语义候选；已按作者、具体视频和发布时间收录关注作者的新作品':'OpenRouter 每日调用上限已到；语义候选保留待审，关注作者的新视频按发布元数据独立收录';
      }
      else if (selected.length) {
        const prepared: Evidence[][] = []; let evidenceCount = 0;
        const inputHashes=new Map<string,string>();
        const reservedOther=selected.filter(item=>item.sourceKind!=='x').length;
        const materialLimits={x:settings.candidatePerRunLimit-reservedOther,other:selected.some(item=>item.sourceKind==='x')?reservedOther:settings.candidatePerRunLimit};
        const materialCounts={x:0,other:0};
        for (const item of selected) {
          if (evidenceCount >= settings.candidatePerRunLimit) break;
          const lane=item.sourceKind==='x'?'x':'other';
          if(materialCounts[lane]>=materialLimits[lane])continue;
          // Selected primary materials have already passed readable-original checks.
          // Reuse them; optional metric refresh runs separately within its budget.
          const value = applyQuality(item, classified); save(value);
          if(value.quality?.decision === 'filtered') continue;
          if(value.publishedAt && Date.parse(value.publishedAt)<since) {
            save({...value,quality:{version:value.quality!.version,decision:'filtered',reason:'原文发布时间超出本轮监控窗口，不作为新事件'}}); continue;
          }
          let group: Evidence[] = [value];
          const existingEvidence=awaiting.filter(signal=>signal.evidence.some(ev=>evidenceKey(ev)===evidenceKey(value))).flatMap(signal=>signal.evidence);
          group.push(...existingEvidence.filter(ev=>ev.id!==value.id&&ev.original));
          if (item.sourceKind === 'x'||linkedUrls(item).some(officialUrl)) {
            const linked = recheck ? all.filter(ev => ev.sourceKind !== 'x' && linkedUrls(item).some(url=>url===ev.url||url===ev.finalUrl)) : await this.collector.linked(item,all);
            // Old linked originals remain context so a fresh tweet cannot conceal the original date.
            const usable = linked.filter(link => link.original);
            for (const link of linked) { ingest(this.store, link); save(link); }
            group.push(...usable);
          }
          if (!recheck && (!group.some(ev => ev.official && ev.original) || !value.publishedAt) && webRequests < settings.searchPerRunLimit) {
            const engines = sources.filter(source => source.enabled && source.kind === 'web' && !source.format && !failedEngines.has(source.id)).sort((a,b)=>a.id.localeCompare(b.id));
            const engine = engines[webRequests % engines.length];
            if (engine) {
              const query = value.title.slice(0,100) + ' official announcement'; webRequests++;
              const found = await collect(engine, () => this.collector.web(engine, query), 'verification', query);
              const originals=await mapConcurrent(found.filter(item=>item.quality?.decision !== 'filtered').slice(0,2),2,async link=>applyQuality(nonTwitterDiscovery(link,started)?link:await this.collector.enrich(link)));
              for (const ev of originals) { ingest(this.store, ev); save(ev); if(ev.quality?.decision === 'eligible' || ev.original && expiredEvidence(ev)) group.push(ev); }
            }
          }
          group.push(...classified.filter(ev => ev.quality?.decision === 'context' && (ev.inReplyToId === value.externalId || ev.conversationId === value.externalId)));
          group = mergeEvidence(group).slice(0,8);
          group=group.slice(0,Math.min(settings.candidatePerRunLimit-evidenceCount,materialLimits[lane]-materialCounts[lane]));
          const inputHash=hash(JSON.stringify([fingerprint,group.map(ev=>[evidenceKey(ev),ev.title,ev.contentHash,ev.author,ev.authorName,ev.authorId,ev.postType,ev.publishedAt,ev.original,ev.official,ev.contentKind,ev.quality?.decision]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]));
          if(!recheck&&this.store.get<{hash:string}>('verification-inputs',value.id)?.hash===inputHash)continue;
          inputHashes.set(value.id,inputHash);
          evidenceCount += group.length;materialCounts[lane]+=group.length; prepared.push(group);
        }
        // Keep each tweet with its linked originals in the same AI batch.
        const batches: Evidence[][][] = [];
        for (const group of prepared) { const last = batches.at(-1); if (!last || mergeEvidence([...last.flat(), ...group]).length > 8) batches.push([group]); else last.push(group); }
        for (let batchIndex=0;batchIndex<batches.length;batchIndex++) {
          const groups=batches[batchIndex],batch=mergeEvidence(groups.flat());
          try {
            const prior = this.store.list<Signal>('events');
            const analysisRules=this.store.list<Rule>('rules').filter(rule=>rule.enabled);
            const { signals, excludedEvidenceIds,exclusions=[],issues=[],deferredEvidenceIds=[] } = await this.analyzer.analyze(batch, analysisRules, prior);
            const deferred=new Set(deferredEvidenceIds);
            const withdrawn=withdrawExcludedMatches(prior,exclusions,batch,analysisRules);
            const unresolved=new Set([...deferred,...issues.flatMap(issue=>issue.evidenceIds),...exclusions.filter(item=>item.category==='insufficient').map(item=>item.evidenceId)]);
            if(issues.length)run.message=[run.message,...new Set(issues.map(issue=>issue.message))].filter(Boolean).join('；');
            const aliases=new Map<string,Candidate[]>();
            for(const item of this.store.list<Candidate>('candidates')) {const key=evidenceKey(item);const bucket=aliases.get(key)||[];bucket.push(item);aliases.set(key,bucket);}
            this.store.transaction(() => {
              for(const signal of withdrawn)if(!signals.some(item=>item.id===signal.id)) {this.store.put('relevance-withdrawn-audit',signal.id,this.store.get('events',signal.id));this.store.put('events',signal.id,signal);}
              for (const signal of signals) { if (!this.store.get('events', signal.id) && currentSignal(signal)) run.newSignals++; this.store.put('events', signal.id, signal); }
              for (const item of batch) {
                const related = signals.filter(signal => signal.evidence.some(ev => ev.id === item.id));
                const done = expiredEvidence(item) || !unresolved.has(item.id) && (excludedEvidenceIds.includes(item.id) || !!related.length && related.every(signal => signal.status !== 'pending' || signal.auditOnly));
                const old = this.store.get<Candidate>('candidates', item.id); if (!old) continue;
                if(inputHashes.has(item.id)&&!unresolved.has(item.id)){
                  if(related.some(signal=>signal.status==='pending'&&!signal.auditOnly))this.store.put('verification-inputs',item.id,{hash:inputHashes.get(item.id),at:Date.now()});
                  else this.store.remove('verification-inputs',item.id);
                }
                this.store.put('candidates', item.id, { ...old, processedHash: done ? item.contentHash : null, analysisFingerprint:fingerprint, relevanceExclusion:exclusions.find(value=>value.evidenceId===item.id), attempts: (old.analysisFingerprint===fingerprint?old.attempts:0) + (deferred.has(item.id)?0:1) });
                for (const alias of (aliases.get(evidenceKey(item)) || []).filter(ev => ev.id !== item.id && ev.contentHash === item.contentHash)) this.store.put('candidates', alias.id, { ...alias, processedHash: done ? alias.contentHash : null, analysisFingerprint:fingerprint, relevanceExclusion:exclusions.find(value=>value.evidenceId===item.id), attempts: (old.analysisFingerprint===fingerprint?old.attempts:0) + (deferred.has(item.id)?0:1) });
              }
            });
            run.analyzed += batch.filter(item=>!unresolved.has(item.id)).length; this.store.put('runs', run.id, run);
          } catch (error) {
            // Retry smaller outputs without penalizing evidence for a formatting
            // capacity failure. Commit each successful half through the usual path.
            if(/AI 输出被截断或为空/.test(safeError(error))&&groups.length>1){
              const middle=Math.ceil(groups.length/2);
              batches.splice(batchIndex+1,0,groups.slice(0,middle),groups.slice(middle));
              continue;
            }
            run.message = safeError(error);
            for (const item of batch) { const old = this.store.get<Candidate>('candidates', item.id); if (old) this.store.put('candidates', item.id, { ...old, analysisFingerprint:fingerprint, attempts: (old.analysisFingerprint===fingerprint?old.attempts:0) + 1 }); }
            break;
          }
        }
      }
      const current = this.store.list<Candidate>('candidates');
      const provenance=new Map(mergeEvidence(current).map(item=>[evidenceKey(item),item.discoveredBy || [item.sourceId]]));
      for(const item of current) { item.discoveredBy=provenance.get(evidenceKey(item)); this.store.put('candidates',item.id,item); }
      for (const source of sources) {
        const result = run.sources.find(value => value.sourceId === source.id); if (!result) continue;
        const values = current.filter(item => item.sourceId === source.id && Date.parse(item.fetchedAt) >= started);
        result.originalCount = values.filter(item => item.original).length;
        result.uniqueCount = mergeEvidence(values).filter(item => (item.discoveredBy || [item.sourceId]).length === 1).length;
        result.filtered = values.filter(item => item.quality?.decision === 'filtered').length; result.filterReasons = {};
        for (const item of values.filter(item => item.quality?.decision === 'filtered')) result.filterReasons[item.quality!.reason] = (result.filterReasons[item.quality!.reason] || 0) + 1;
      }
      syncEvidenceMetadata(this.store);
      for (const rule of rules) { const currentRule = this.store.get<Rule>('rules', rule.id); if (currentRule) this.store.put('rules', rule.id, { ...currentRule, baselineAt: currentRule.baselineAt || run.startedAt, lastRunAt: run.startedAt, nextRunAt: new Date(started + INTERVAL_MS).toISOString() }); }
      const active = run.sources.filter(item => item.status !== 'disabled' && item.status !== 'standby'); const succeeded = active.filter(item => ['success', 'empty', 'cached', 'partial'].includes(item.status));
      run.status = !succeeded.length ? 'failed' : active.some(item => ['failed', 'unconfigured', 'partial', 'limited'].includes(item.status)) || !!run.message ? 'partial' : 'success';
      if (!run.message) run.message = run.status === 'failed' ? '所有启用来源均未成功，请查看来源记录' : '采集 ' + unique.length + ' 条候选，分析 ' + run.analyzed + ' 条，新增 ' + run.newSignals + ' 个事件；过滤 ' + current.filter(item=>item.quality?.decision === 'filtered' && Date.parse(item.fetchedAt)>=started).length + ' 条';
    } catch (error) { run.status = 'failed'; run.message = safeError(error); }
    finally { run.finishedAt = new Date().toISOString(); this.store.put('runs', run.id, run); clearInterval(renewal); this.store.release('scan', owner); }
    return run;
  }
}
