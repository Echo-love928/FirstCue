import { fixtureAssessment } from './analysis-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FRESHNESS_MS, currentSignal, defaultSignal, signalTime, withinWindow } from '../shared/freshness.js';
import type { Candidate, Evidence, Rule, Signal, Source } from '../shared/types.js';
import { analysisSchema, validateBatch } from '../server/ai.js';
import { Store } from '../server/db.js';
import { dashboard } from '../server/app.js';
import { makeEvidence, hash } from '../server/parse.js';
import { applyQuality, discoveryCandidate, QUALITY_VERSION } from '../server/quality.js';
import { Collector, ingest } from '../server/sources.js';
import { expireContent } from '../server/retention.js';
import { Runner } from '../server/runner.js';
import { eligible, Mailer, queueNotifications } from '../server/mail.js';

const now=Date.now();
const date=new Date(now-60000).toISOString();
const x:Source={id:'twitter',name:'X',kind:'x',url:'https://api.twitterapi.io',enabled:true,official:false};
const rule:Rule={id:'rule',name:'AI',query:'AI',kind:'topic',enabled:true,notify:false,createdAt:date,baselineAt:date,lastRunAt:null,nextRunAt:date};
const post=(id='1',extra:Partial<Evidence>={})=>applyQuality(makeEvidence(x,{url:`https://x.com/author/status/${id}`,title:'New model release',text:'The project released version 2 today with new code completion features.',externalId:id,publishedAt:date,original:true,postType:'original',likes:10,reposts:5,views:500,authorFollowers:100,...extra}));
const data=(ev:Evidence)=>analysisSchema.parse({events:[{title:'New model release',summary:'New version with code completion.',entity:'model',version:'2',eventType:'release',occurredAt:null,isNewsworthy:true,isNewEvent:true,status:'confirmed',reason:'Original post',attention:50,attentionReason:'New feature', importance: 'medium', importanceReason: 'Fixture impact',tags:[],evidenceIds:[ev.id],ruleIds:[rule.id],ruleAssessments:[fixtureAssessment(ev,rule)],existingEventId:null}],excludedEvidenceIds:[]});
const signal=(ev=post())=>validateBatch(data(ev),[ev],[rule],[],now).signals[0];

test('5 天边界包含整 120 小时，超过一毫秒排除；未来或未知时间无效',()=>{
  assert.equal(withinWindow(new Date(now-FRESHNESS_MS).toISOString(),now),true);
  assert.equal(withinWindow(new Date(now-FRESHNESS_MS-1).toISOString(),now),false);
  assert.equal(withinWindow(new Date(now+86400000).toISOString(),now),false);
  assert.equal(withinWindow(null,now),false);
});

test('无外链的实质原创可进入首页待核实，不会凭单条普通推文确认',()=>{
  const ev=post();const result=signal(ev);
  assert.equal(discoveryCandidate(ev,now),true);assert.equal(result.status,'pending');
  assert.equal(defaultSignal(result,now),true);assert.equal(signalTime(result,now),Date.parse(date));
  assert.equal(currentSignal({...result,evidence:[],occurredAt:null},now),false);
});

test('网页与官方 RSS 需要可读原文与真实发布时间，修改或抓取时间不能替代',()=>{
  const ev=post();
  assert.equal(discoveryCandidate({...ev,sourceKind:'web'},now),false);
  const official={...ev,sourceKind:'rss' as const,finalUrl:'https://openai.com/news/release',contentKind:'feed' as const,text:'Original model release with detailed new capabilities. '.repeat(4),official:true};
  assert.equal(discoveryCandidate(official,now),true);
  assert.equal(discoveryCandidate({...official,publishedAt:null,updatedAt:date,fetchedAt:date},now),false);
  assert.equal(currentSignal({...signal(),occurredAt:new Date(now-FRESHNESS_MS-1).toISOString(),firstSeenAt:date,updatedAt:date},now),false);
});

test('旧闻重述、普通官方案例或 AI 判为无选题价值均保留审计但不展示',()=>{
  const ev=post();const request=data(ev);
  request.events[0].isNewEvent=false;
  assert.equal(validateBatch(request,[ev],[rule],[],now).signals[0].auditOnly,true);
  request.events[0].isNewEvent=true;request.events[0].isNewsworthy=false;
  assert.equal(validateBatch(request,[ev],[rule],[],now).signals[0].auditOnly,true);
  request.events[0].isNewsworthy=true;request.events[0].title='A customer story';
  assert.equal(validateBatch(request,[ev],[rule],[],now).signals[0].auditOnly,true);
});

test('合并不能用新发帖日期刷新旧事件',()=>{
  const ev=post();const old={...signal(ev),occurredAt:new Date(now-FRESHNESS_MS-1000).toISOString()};
  const request=data(ev);request.events[0].existingEventId=old.id;request.events[0].occurredAt=date;
  const merged=validateBatch(request,[ev],[rule],[old],now).signals[0];
  assert.equal(merged.occurredAt,old.occurredAt);assert.equal(currentSignal(merged,now),false);
});

test('闲置时也过期：接口立即隐藏，清理只标记且不删原文，重试和邮件都停止',async()=>{
  const store=new Store(':memory:');try{
    store.put('state','settings',{...store.settings(),recipient:'test@example.com'});
    const ev=post();const value=signal(ev);const r={...rule,kind:'keyword' as const,notify:true,baselineAt:new Date(now-3600000).toISOString()};
    const confirmed={...value,ruleAssessments:value.ruleAssessments!.map(item=>({...item,ruleKind:r.kind,ruleFingerprint:JSON.stringify([r.kind,r.query.toLowerCase()])})),status:'confirmed' as const,occurredAt:date};
    ingest(store,ev);store.put('events',confirmed.id,confirmed);store.put('rules',r.id,r);
    assert.equal(queueNotifications(store,[confirmed],[r],now),1);
    let sent=0;const mailer=new Mailer(store,{verify:async()=>true,sendMail:async()=>{sent++;return{accepted:['test@example.com']};}});
    const expired=now+FRESHNESS_MS+60000;
    assert.equal(eligible(confirmed,r,expired),false);
    const counts=expireContent(store,expired);assert.deepEqual(counts,{candidates:1,events:1});
    assert.equal(dashboard(store).events.length,0);assert.equal(store.list('events').length,1);
    const saved=store.get<Candidate>('candidates',ev.id)!;
    assert.equal(saved.text,ev.text);assert.equal(saved.processedHash,saved.contentHash);assert.equal(saved.quality?.decision,'filtered');
    await mailer.flush(expired,true,true);assert.equal(sent,0);assert.equal(store.list<{status:string}>('mail')[0].status,'failed');
    assert.deepEqual(expireContent(store,expired),{candidates:0,events:0});
  }finally{store.close();}
});

test('API 动态过滤已经过期且尚未被后台标记的事件',()=>{
  const store=new Store(':memory:');try{
    const old=signal(post('old',{publishedAt:new Date(now-FRESHNESS_MS-60000).toISOString()}));
    store.put('events',old.id,{...old,auditOnly:false});
    assert.equal(dashboard(store).events.length,0);assert.equal(store.list('events').length,1);
  }finally{store.close();}
});

test('新推文引用的旧原文仍送入审核，防止丢失旧闻时间依据',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);
    store.put('sources',x.id,x);store.put('rules',rule.id,rule);
    const ev=post('new',{outboundUrls:['https://openai.com/news/old']});ingest(store,ev);
    const old=makeEvidence({...x,kind:'web'},{url:'https://openai.com/news/old',title:'Old release',publishedAt:'2020-01-01T00:00:00.000Z',text:'Old original release announcement. '.repeat(5),original:true,official:true});ingest(store,applyQuality(old));
    let checked=false;
    const run=await new Runner(store,new Collector(store,{request:async()=>{throw Error('No network on recheck');}},'',false),{analyze:async evidence=>{
      checked=true;assert.ok(evidence.some(item=>item.id===old.id&&item.publishedAt===old.publishedAt));
      const request=data(ev);request.events[0].occurredAt=old.publishedAt;request.events[0].isNewEvent=false;request.events[0].evidenceIds=evidence.map(item=>item.id);
      return validateBatch(request,evidence,[rule],[]);
    }}).scan('重新核实');
    assert.equal(checked,true);assert.equal(run?.newSignals,0);assert.equal(dashboard(store).events.length,0);
  }finally{store.close();}
});

test('合并指针错误不丢失已核验候选，另存事件且保留原事件和其他结果',async()=>{
  const store=new Store(':memory:');try{
    store.put('rules',rule.id,rule);for(const source of store.list<Source>('sources'))store.remove('sources',source.id);store.put('sources',x.id,x);
    const a=post('a'),b=post('b');ingest(store,a);ingest(store,b);
    const existing={...signal(a),id:'prior-v1',eventKey:'prior-v1',version:'1',screeningVersion:QUALITY_VERSION};store.put('events',existing.id,existing);
    const run=await new Runner(store,new Collector(store,{request:async()=>{throw Error('No network on recheck');}},'',false),{analyze:async evidence=>{
      const good=data(b).events[0];good.status='rejected';good.version='3';
      const bad={...data(a).events[0],existingEventId:existing.id};
      return validateBatch({events:[bad,good],excludedEvidenceIds:[],exclusions:[]},evidence,[rule],[existing]);
    }}).scan('重新核实');
    assert.equal(run?.analyzed,2);
    assert.equal(store.get<Candidate>('candidates',a.id)?.processedHash,null);
    assert.equal(store.get<Candidate>('candidates',b.id)?.processedHash,b.contentHash);
    assert.equal(store.list<Signal>('events').length,3);
    assert.equal(store.get<Signal>('events',existing.id)?.version,'1');
    const recovered=store.list<Signal>('events').find(item=>item.id!==existing.id&&item.evidence.some(ev=>ev.id===a.id))!;
    assert.equal(currentSignal(recovered),true);assert.equal(recovered.version,'2');assert.deepEqual(recovered.evidence.map(ev=>ev.id),[a.id]);
  }finally{store.close();}
});

test('仅完成作者元数据匹配时，未审语义候选保持待审且不消耗重试次数',async()=>{
  const store=new Store(':memory:');try{
    store.put('rules',rule.id,rule);for(const source of store.list<Source>('sources'))store.remove('sources',source.id);store.put('sources',x.id,x);
    const ev=post('deferred');ingest(store,ev);
    const runner=new Runner(store,new Collector(store,{request:async()=>{throw Error('No network on recheck');}},'',false),{analyze:async evidence=>({signals:[],excludedEvidenceIds:[],deferredEvidenceIds:evidence.map(item=>item.id)})});
    for(let index=0;index<4;index++)await runner.scan('重新核实');
    const saved=store.get<Candidate>('candidates',ev.id)!;
    assert.equal(saved.processedHash,null);assert.equal(saved.attempts,0);assert.equal(dashboard(store).pendingAnalysis,1);
  }finally{store.close();}
});

test('过期 X 检查点直接重置到 5 天内，不消耗请求追查已过期窗口',async()=>{
  const store=new Store(':memory:');try{
    store.put('checkpoints',hash('x:quality-v2:AI'),{since:now-10*86400000,until:now-6*86400000,cursor:'expired'});
    const urls:URL[]=[];
    const collector=new Collector(store,{request:async url=>{urls.push(new URL(url));return{status:200,url,headers:{},text:JSON.stringify({tweets:[],has_next_page:false,next_cursor:null})};}},'test-key',false);
    await collector.x(x,'AI',now-FRESHNESS_MS);
    assert.equal(urls[0].searchParams.get('cursor'),'');
    const since=Number(urls[0].searchParams.get('query')!.match(/since_time:(\d+)/)![1]);
    assert.ok(since>=Math.floor((now-FRESHNESS_MS)/1000));
  }finally{store.close();}
});
