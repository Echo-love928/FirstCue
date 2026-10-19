import { randomUUID } from 'node:crypto';
import type { Candidate, FeishuJob, MailJob, NotificationDigest, Rule, Signal } from '../shared/types.js';
import { currentSignal } from '../shared/freshness.js';
import { matchesRule } from '../shared/relevance.js';
import { primaryEvidence, selectTopSignals } from '../shared/feed.js';
import { metricRows, formatCount } from '../shared/engagement.js';
import { collectedSignals, discoveryMatches } from './collected-feed.js';
import { evidenceKey } from './quality.js';
import { config, INTERVAL_MS, safeError } from './config.js';
import { hash } from './parse.js';
import type { Store } from './db.js';

export interface DigestSchedule { activatedAt:string; nextAt:string; lastAt:string|null; initial:boolean; initialMailTarget:string; initialFeishuTarget:string; }
const mailTarget=(recipient:string)=>hash(recipient.trim().toLowerCase());
const keys=(signal:Signal)=>[...new Set(signal.evidence.map(evidenceKey))];
const iso=(time:number)=>new Date(time).toISOString();
const title=(count:number)=>`精选热点汇总 · ${count} 条`;
const escape=(text:string)=>text.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function digestEligible(signal:Signal,rules:Rule[],now=Date.now()):boolean {
  return signal.status!=='rejected'&&currentSignal(signal,now)&&rules.some(rule=>rule.enabled&&rule.notify&&signal.ruleIds.includes(rule.id)&&(signal.discoveryOnly?signal.evidence.some(item=>discoveryMatches(item,rule)):signal.relevanceVersion===undefined||matchesRule(signal,rule)));
}
export function digestSelection(store:Store,now=Date.now()):Signal[] {
  const rules=store.list<Rule>('rules');
  const events=store.list<Signal>('events').map(signal=>signal.relevanceVersion===undefined?signal:{...signal,ruleIds:signal.ruleIds.filter(id=>{const rule=rules.find(item=>item.id===id);return !!rule&&matchesRule(signal,rule);})}).filter(signal=>currentSignal(signal,now));
  const all=[...events,...collectedSignals(store.list<Candidate>('candidates'),rules,events,now)];
  // Use the same hot 100 as the default feed, then honor each monitor's switch.
  return selectTopSignals(all,{source:'all',importance:'all',keyword:'all',timeRange:'5d',status:'all',search:'',sort:'heat'},now).items.filter(signal=>digestEligible(signal,rules,now));
}
export function queueDigestNotifications(store:Store,now=Date.now()):number {
  let count=0;
  store.transaction(()=>{
    const settings=store.settings(),mailId=mailTarget(settings.recipient),feishuId=hash(config.feishuWebhook);
    let schedule=store.get<DigestSchedule>('state','digestSchedule');
    if(!schedule){
      schedule={activatedAt:iso(now),nextAt:iso(now),lastAt:null,initial:true,initialMailTarget:settings.recipient?mailId:'',initialFeishuTarget:settings.feishuEnabled&&config.feishuWebhook?feishuId:''};
      store.put('state','digestSchedule',schedule);
      for(const channel of ['mail','feishu'])for(const job of store.list<MailJob>(channel).filter(job=>!job.digest&&['pending','retry'].includes(job.status)))store.put(channel,job.id,{...job,status:'failed',error:'已改为 30 分钟汇总，停止逐条发送'});
    }
    // Track recipient changes so older material cannot leak to a new destination.
    const previousMail=store.get<{targetId:string;activatedAt:string}>('state','digestMailTarget');
    if(!previousMail||previousMail.targetId!==mailId)store.put('state','digestMailTarget',{targetId:mailId,activatedAt:iso(now)});
    if(Date.parse(schedule.nextAt)>now)return;
    const selected=digestSelection(store,now),rules=store.list<Rule>('rules');
    const ruleNames=Object.fromEntries(rules.filter(rule=>rule.enabled&&rule.notify).map(rule=>[rule.id,rule.name]));
    for(const channel of ['mail','feishu'] as const){
      if(channel==='mail'&&!settings.recipient||channel==='feishu'&&(!settings.feishuEnabled||!config.feishuWebhook))continue;
      const targetId=channel==='mail'?mailId:feishuId;
      const subscription=channel==='mail'?store.get<{targetId:string;activatedAt:string}>('state','digestMailTarget'):store.get<{targetId:string;activatedAt:string}>('state','feishuSubscription');
      if(!subscription||subscription.targetId!==targetId)continue;
      const initial=schedule.initial&&targetId===(channel==='mail'?schedule.initialMailTarget:schedule.initialFeishuTarget);
      const seen=new Set(store.list<MailJob>(channel).filter(job=>job.digest?.targetId===targetId).flatMap(job=>job.digest!.keys));
      const signals=selected.filter(signal=>{
        if(!initial&&Date.parse(signal.firstSeenAt)<=Date.parse(subscription.activatedAt))return false;
        const references=keys(signal);if(references.some(key=>seen.has(key)))return false;
        for(const key of references)seen.add(key);return true;
      });
      if(!signals.length)continue;
      const digest:NotificationDigest={periodStartAt:schedule.lastAt||iso(now-INTERVAL_MS),periodEndAt:iso(now),signals,keys:[...new Set(signals.flatMap(keys))],targetId,initial,ruleNames};
      const id=hash(`digest:${channel}:${targetId}:${schedule.nextAt}`);
      const job:MailJob={id,eventId:id,ruleId:'digest',title:title(signals.length),recipient:channel==='mail'?settings.recipient:'飞书群机器人',status:'pending',attempts:0,nextAttemptAt:iso(now),createdAt:iso(now),submittedAt:null,error:null,messageId:`<digest-${id}@signal.local>`,signal:signals[0],digest};
      store.put(channel,id,channel==='feishu'?{...job,channel,targetId}:job);count++;
    }
    store.put('state','digestSchedule',{...schedule,lastAt:iso(now),nextAt:iso(now+INTERVAL_MS),initial:false});
  });return count;
}

type DigestJob=MailJob|FeishuJob;
export async function flushDigestJobs(store:Store,channel:'mail'|'feishu',send:(job:DigestJob,digest:NotificationDigest)=>Promise<number|void>,now=Date.now()):Promise<void>{
  const owner=randomUUID(),lease=`digest-send:${channel}`;
  if(!store.lease(lease,owner,90000))return;
  try{
    const settings=store.settings(),targetId=channel==='mail'?mailTarget(settings.recipient):hash(config.feishuWebhook);
    const last=store.get<number>('state',`digestAttempt:${channel}:${targetId}`);
    if(last!==null&&now-last<INTERVAL_MS)return;
    const jobs=store.list<DigestJob>(channel).filter(job=>job.digest&&['pending','retry'].includes(job.status)&&Date.parse(job.nextAttemptAt)<=now).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
    for(const job of jobs){
      const subscription=channel==='mail'?store.get<{targetId:string;activatedAt:string}>('state','digestMailTarget'):store.get<{targetId:string;activatedAt:string}>('state','feishuSubscription');
      const validTarget=job.digest!.targetId===targetId&&!!subscription&&subscription.targetId===targetId&&Date.parse(job.createdAt)>=Date.parse(subscription.activatedAt);
      const signals=job.digest!.signals.filter(signal=>digestEligible(signal,store.list<Rule>('rules'),now));
      if(!validTarget||!signals.length){store.put(channel,job.id,{...job,status:'failed',error:'接收目标或监控已改变、内容过期，取消此份汇总'});continue;}
      const digest={...job.digest!,signals,keys:[...new Set(signals.flatMap(keys))]};
      const updated={...job,digest,title:title(signals.length),signal:signals[0],attempts:job.attempts+1,nextAttemptAt:iso(now+INTERVAL_MS)};
      // Persist the attempt before IO. Restarts cannot create a burst of sends.
      store.transaction(()=>{store.put('state',`digestAttempt:${channel}:${targetId}`,now);store.put(channel,job.id,updated);});
      try{
        const renderedCount=await send(updated,digest);
        store.put(channel,job.id,{...updated,digest:{...digest,...(typeof renderedCount==='number'?{renderedCount}:{})},status:'submitted',submittedAt:iso(now),error:null});
      }catch(error){store.put(channel,job.id,{...updated,status:updated.attempts>=4?'failed':'retry',error:safeError(error)});}
      return; // At most one aggregate attempt per channel every 30 minutes.
    }
  }finally{store.release(lease,owner);}
}

function sourceLink(signal:Signal):{url:string;title:string}|null {
  const evidence=primaryEvidence(signal)||signal.evidence[0];if(!evidence)return null;
  try{const url=new URL(evidence.finalUrl);return /^https?:$/.test(url.protocol)&&!url.username&&!url.password?{url:url.href,title:evidence.title}:null;}catch{return null;}
}
export function mailDigestContent(digest:NotificationDigest):{text:string;html:string}{
  const heading=`FirstCue · ${title(digest.signals.length)}`;
  const period=digest.initial?'首份当前精选汇总':`${time(digest.periodStartAt)} — ${time(digest.periodEndAt)}（北京时间）`;
  const blocks=digest.signals.map((signal,index)=>{
    const source=sourceLink(signal),primary=primaryEvidence(signal)||signal.evidence[0];
    const metrics=primary?metricRows(primary).filter(row=>row.value!==undefined).map(row=>`${row.label} ${formatCount(row.value)}`).join(' · '):'';
    const names=signal.ruleIds.map(id=>digest.ruleNames[id]).filter(Boolean).join('、');
    return{title:`${index+1}. ${signal.title}`,summary:signal.summary.slice(0,500),metrics,names,source};
  });
  return{text:[heading,period,...blocks.map(item=>[item.title,item.summary,item.metrics,`监控：${item.names}`,item.source?.url||''].filter(Boolean).join('\n'))].join('\n\n'),
    html:`<h1>${escape(heading)}</h1><p>${escape(period)}</p>${blocks.map(item=>`<section><h2>${escape(item.title)}</h2><p>${escape(item.summary)}</p><p>${escape(item.metrics)}</p><p>监控：${escape(item.names)}</p>${item.source?`<p><a href="${escape(item.source.url)}">查看原始来源</a></p>`:''}</section>`).join('')}`};
}
export function feishuDigestContent(digest:NotificationDigest):{message:Record<string,unknown>;renderedCount:number}{
  const rows:Record<string,string>[][]=[[{tag:'text',text:digest.initial?'首份当前精选汇总':`${time(digest.periodStartAt)} — ${time(digest.periodEndAt)}（北京时间）`}]];
  const make=()=>({msg_type:'post',content:{post:{zh_cn:{title:`[FirstCue] ${title(digest.signals.length)}`,content:rows}}}});
  let renderedCount=0;
  for(const signal of digest.signals){
    const source=sourceLink(signal),label=`${renderedCount+1}. ${Array.from(signal.title.replace(/[\u0000-\u001f]/g,' ')).slice(0,64).join('')}`;
    rows.push([source&&source.url.length<1800?{tag:'a',text:label,href:source.url}:{tag:'text',text:label}]);
    if(Buffer.byteLength(JSON.stringify(make()),'utf8')>18*1024){rows.pop();break;}renderedCount++;
  }
  rows.push([{tag:'text',text:renderedCount<digest.signals.length?`正文列出 ${renderedCount} 条；本期完整 ${digest.signals.length} 条请在 FirstCue「通知记录」展开汇总查看，邮箱启用时也提供完整内容。`:'本期热点已整体汇总，完整摘要与互动数据可在 FirstCue「通知记录」查看，邮箱启用时也提供完整内容。'}]);
  return{message:make(),renderedCount};
}
