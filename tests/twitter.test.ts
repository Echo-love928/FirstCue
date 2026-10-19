import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.js';
import { Collector, ingest } from '../server/sources.js';
import { applyQuality, selectCandidates } from '../server/quality.js';
import { makeEvidence } from '../server/parse.js';
import { syncTwitterEvents } from '../server/twitter-policy.js';
import { currentSignal } from '../shared/freshness.js';
import { twitterHeat, twitterMetrics, TWITTER_METRICS_INTERVAL } from '../shared/twitter.js';
import { Runner } from '../server/runner.js';
import type { Candidate, Evidence, Rule, Signal, Source } from '../shared/types.js';

const now=Date.now();const date=new Date(now-60000).toISOString();
const source:Source={id:'twitter',name:'X',kind:'x',url:'https://api.twitterapi.io',enabled:true,official:false};
const post=(id='1',extra:Partial<Evidence>={})=>applyQuality(makeEvidence(source,{url:`https://x.com/author/status/${id}`,externalId:id,title:'New model release',text:'The project released a new coding model with improved completions.',publishedAt:date,postType:'original',original:true,likes:10,reposts:5,views:500,authorFollowers:100,...extra}));
const tweet=(id='1',extra:Record<string,unknown>={})=>({id,url:`https://x.com/author/status/${id}`,text:'The project released a new coding model with improved completions.',createdAt:date,isReply:false,author:{id:'author',userName:'author',followers:100,isBlueVerified:true},likeCount:10,retweetCount:5,viewCount:500,...extra});
const doc=(tweets:unknown[],extra:Record<string,unknown>={})=>({status:200,url:source.url,headers:{},text:JSON.stringify({status:'success',tweets,...extra})});
const signal=(ev:Evidence):Signal=>({id:'event',eventKey:'event',title:'Release',summary:'New coding model',entity:'model',version:'1',eventType:'release',occurredAt:date,status:'pending',reason:'Pending proof',attention:50,attentionReason:'New feature',tags:[],evidence:[ev],ruleIds:['rule'],firstSeenAt:date,updatedAt:date,isNewsworthy:true,isNewEvent:true,screeningVersion:2,twitterFilterVersion:1});

test('四项指标精确边界全部达到才通过，缺失/负数/非数值不能放行',()=>{
  assert.equal(twitterMetrics(post()).passed,true);
  for(const key of ['likes','reposts','views','authorFollowers'] as const)for(const value of [undefined,-1,NaN,Infinity,0.5])assert.equal(twitterMetrics(post('1',{[key]:value})).passed,false,key);
  assert.equal(twitterMetrics(post('1',{metricsUnavailable:true})).passed,false);
});

test('蓝 V 同时效热度分加权 10%，不更改官方身份或越过硬门槛',()=>{
  const plain=post('plain');const blue=post('blue',{authorBlueVerified:true});
  assert.equal(twitterHeat(blue),twitterHeat(plain)*1.1);assert.equal(blue.official,false);
  const candidates=[plain,blue].map(item=>({...item,processedHash:null,attempts:0}));
  assert.equal(selectCandidates(candidates,2)[0].id,blue.id);
  assert.equal(selectCandidates([{...post('bad',{authorBlueVerified:true,likes:4}),attempts:0,processedHash:null}],2).length,0);
});

test('正文未变但指标达标恢复审核；重复采集不会重置 AI 重试次数',()=>{
  const store=new Store(':memory:');try{
    const low=post('1',{likes:4});ingest(store,low);store.put('candidates',low.id,{...store.get<Candidate>('candidates',low.id),attempts:3,processedHash:low.contentHash});
    ingest(store,post());let saved=store.get<Candidate>('candidates',low.id)!;
    assert.equal(saved.contentHash,low.contentHash);assert.equal(saved.quality?.decision,'eligible');assert.equal(saved.attempts,0);assert.equal(saved.processedHash,null);
    store.put('candidates',low.id,{...saved,attempts:2});ingest(store,post());saved=store.get<Candidate>('candidates',low.id)!;assert.equal(saved.attempts,2);
  }finally{store.close();}
});

test('从真实结构保存粉丝数与蓝 V，零值保留、缺失不伪造',async()=>{
  const store=new Store(':memory:');try{
    const collector=new Collector(store,{request:async()=>doc([tweet('1',{author:{id:'a',userName:'a',followers:0,isBlueVerified:false},viewCount:null})],{has_next_page:false,next_cursor:null})},'key',false);
    const item=(await collector.x(source,'model',now-86400000)).items[0];
    assert.equal(item.authorFollowers,0);assert.equal(item.authorBlueVerified,false);assert.equal(item.views,undefined);assert.equal(item.quality?.decision,'filtered');
  }finally{store.close();}
});

test('批量回查每轮最多 50 个，30 分钟内不重复查同一推文且共用现有预算',async()=>{
  const store=new Store(':memory:');try{
    for(let id=0;id<60;id++)ingest(store,post(String(id),{likes:1}));
    const batches:string[][]=[];
    const collector=new Collector(store,{request:async raw=>{const ids=new URL(raw).searchParams.get('tweet_ids')!.split(',');batches.push(ids);return doc(ids.slice().reverse().map(id=>tweet(id)));}},'key',false);
    const result=await collector.refreshMetrics(source,now);assert.equal(result.items.length,50);assert.equal(store.usage().xRequests,1);assert.equal(store.usage().xResults,50);
    await collector.refreshMetrics(source,now);assert.equal(batches[1].length,10);assert.equal(new Set(batches.flat()).size,60);
    const unchanged=await collector.refreshMetrics(source,now+TWITTER_METRICS_INTERVAL-1);assert.equal(unchanged.items.length,0);assert.equal(batches.length,2);
    await collector.refreshMetrics(source,now+TWITTER_METRICS_INTERVAL);assert.equal(batches.length,3);
  }finally{store.close();}
});

test('缺失、删除或异常返回项按 ID 匹配，先隐藏且不借用别人的指标',async()=>{
  const store=new Store(':memory:');try{
    const first=post('1',{authorFollowers:undefined}),second=post('2',{authorFollowers:undefined});ingest(store,first);ingest(store,second);
    const collector=new Collector(store,{request:async()=>doc([tweet('2'),{id:''}])},'key',false);
    await collector.refreshMetrics(source,now);
    const a=store.get<Candidate>('candidates',first.id)!,b=store.get<Candidate>('candidates',second.id)!;
    assert.equal(a.metricsUnavailable,true);assert.equal(a.authorFollowers,undefined);assert.equal(a.quality?.decision,'filtered');
    assert.equal(b.authorFollowers,100);assert.equal(b.quality?.decision,'eligible');
  }finally{store.close();}
});

test('回查不足整批时遵守剩余预算；预算耗尽不清队列或发请求',async()=>{
  const store=new Store(':memory:');try{
    for(let id=0;id<5;id++)ingest(store,post(String(id),{likes:1}));
    store.reserve('xResults',store.settings().xResultDailyLimit-2,store.settings().xResultDailyLimit);
    let calls=0;const collector=new Collector(store,{request:async raw=>{calls++;return doc(new URL(raw).searchParams.get('tweet_ids')!.split(',').map(id=>tweet(id)));}},'key',false);
    assert.equal((await collector.refreshMetrics(source,now)).items.length,2);
    assert.equal((await collector.refreshMetrics(source,now)).result.status,'limited');assert.equal(calls,1);assert.equal(store.list('candidates').length,5);
  }finally{store.close();}
});

test('网络或业务失败不虚构指标，保留候选并避免立刻重复回查',async()=>{
  const store=new Store(':memory:');try{
    const ev=post('1',{authorFollowers:undefined});ingest(store,ev);let calls=0;
    const collector=new Collector(store,{request:async()=>{calls++;return doc([],{status:'error',msg:'upstream unavailable'});}},'key',false);
    await assert.rejects(collector.refreshMetrics(source,now),/upstream unavailable/);
    assert.equal((await collector.refreshMetrics(source,now)).result.status,'cached');assert.equal(calls,1);
    assert.equal(store.get<Candidate>('candidates',ev.id)?.authorFollowers,undefined);
  }finally{store.close();}
});

test('过期、回复、引用及未知类型不进入指标回查队列',async()=>{
  const store=new Store(':memory:');try{
    ingest(store,post('old',{publishedAt:new Date(now-6*86400000).toISOString()}));
    for(const postType of ['reply','quote','repost','unknown'] as const)ingest(store,post(postType,{postType}));
    let calls=0;const collector=new Collector(store,{request:async()=>{calls++;return doc([]);}},'key',false);
    assert.equal((await collector.refreshMetrics(source,now)).items.length,0);assert.equal(calls,0);assert.equal(store.list('candidates').length,5);
  }finally{store.close();}
});

test('旧版 Twitter 事件须按新门槛重新审核，独立官方 RSS 事件继续展示',()=>{
  const legacy={...signal(post()),twitterFilterVersion:undefined};assert.equal(currentSignal(legacy),false);
  const rss={...post(),sourceKind:'rss' as const,finalUrl:'https://openai.com/news/release',contentKind:'feed' as const,text:'Original release information and detailed new model capabilities. '.repeat(3),official:true};
  assert.equal(currentSignal({...legacy,evidence:[rss,post('reply',{postType:'reply'})]}),true);
});

test('旧事件随指标更新隐藏和恢复，网页/RSS 原有事件不被改写',async()=>{
  const store=new Store(':memory:');try{
    const ev=post('1',{authorFollowers:undefined});ingest(store,ev);const event=signal(ev);store.put('events',event.id,event);
    const rss={...signal({...post(),sourceKind:'rss',official:true}),id:'rss'};store.put('events',rss.id,rss);
    assert.equal(currentSignal(event),false);
    await new Collector(store,{request:async()=>doc([tweet()])},'key',false).refreshMetrics(source,now);syncTwitterEvents(store);
    assert.equal(currentSignal(store.get<Signal>('events',event.id)!),true);assert.deepEqual(store.get('events','rss'),rss);
    ingest(store,post('1',{likes:1}));syncTwitterEvents(store);assert.equal(currentSignal(store.get<Signal>('events',event.id)!),false);
    assert.equal(store.list('events').length,2);
  }finally{store.close();}
});

test('定时检查执行指标回查，达标内容进入分析；原先重新核实仍不联网',async()=>{
  const store=new Store(':memory:');try{
    for(const item of store.list<Source>('sources'))store.remove('sources',item.id);store.put('sources',source.id,source);
    const rule:Rule={id:'rule',name:'model',query:'model',kind:'topic',enabled:true,notify:false,createdAt:date,baselineAt:null,lastRunAt:null,nextRunAt:date};store.put('rules',rule.id,rule);
    ingest(store,post('1',{likes:1}));const calls:string[]=[];
    const collector=new Collector(store,{request:async raw=>{const path=new URL(raw).pathname;calls.push(path);return path==='/twitter/tweets'?doc([tweet()]):doc([],{has_next_page:false,next_cursor:null});}},'key',false);
    const run=await new Runner(store,collector,{analyze:async evidence=>({signals:[],excludedEvidenceIds:evidence.map(item=>item.id)})}).scan('定时检查');
    assert.equal(run?.analyzed,1);assert.ok(run?.sources.some(item=>item.purpose==='metrics'));assert.deepEqual(calls,['/twitter/tweet/advanced_search','/twitter/tweets']);
    await new Runner(store,collector,{analyze:async evidence=>({signals:[],excludedEvidenceIds:evidence.map(item=>item.id)})}).scan('重新核实');assert.equal(calls.length,2);
  }finally{store.close();}
});
