import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.js';
import { Collector, ingest, Throttle } from '../server/sources.js';
import { Runner } from '../server/runner.js';
import { makeEvidence } from '../server/parse.js';
import { applyQuality } from '../server/quality.js';
import { analysisFingerprint } from '../shared/relevance.js';
import { TWITTER_MINIMUM, twitterMetrics } from '../shared/twitter.js';
import type { Candidate, Evidence, Rule, Source } from '../shared/types.js';

const date=new Date(Date.now()-60000).toISOString();
const web:Source={id:'bing',name:'Bing',kind:'web',url:'https://www.bing.com/search',enabled:true,official:false};
const x:Source={...web,id:'twitter',kind:'x',url:'https://api.twitterapi.io'};
const rule:Rule={id:'rule',name:'AI',query:'AI coding agents',kind:'topic',enabled:true,notify:false,createdAt:date,baselineAt:date,lastRunAt:null,nextRunAt:date};
const body='The project released new coding agent capabilities with executable examples and improved code completion. '.repeat(2);
const post=(id:string,extra:Partial<Evidence>={})=>applyQuality(makeEvidence(x,{url:`https://x.com/author/status/${id}`,externalId:id,title:'Coding agent update',text:body,publishedAt:date,author:'author',contentKind:'post',postType:'original',original:true,likes:5,reposts:1,views:200,authorFollowers:50,...extra}));
function setup(sources:Source[]) {
  const store=new Store(':memory:');
  for(const source of store.list<Source>('sources'))store.remove('sources',source.id);
  for(const source of sources)store.put('sources',source.id,source);
  store.put('rules',rule.id,rule);
  return store;
}

test('下调互动门槛后新线索可审核，边界下方和缺失指标仍排除',()=>{
  assert.deepEqual(TWITTER_MINIMUM,{likes:5,reposts:1,views:200,authorFollowers:50});
  assert.equal(post('new').quality?.decision,'eligible');
  for(const [key,min] of Object.entries(TWITTER_MINIMUM)) {
    for(const value of [min-1,undefined])assert.equal(twitterMetrics(post('bad',{[key]:value})).passed,false,key);
  }
  for(const postType of ['reply','quote','repost','unknown'] as const)assert.equal(post(postType,{postType}).quality?.decision,'filtered');
});

test('旧门槛过滤的同正文候选恢复审核资格，不必等待重新搜索',async()=>{
  const store=setup([x]);try{
    const item=post('saved');ingest(store,item);
    store.put('candidates',item.id,{...store.get<Candidate>('candidates',item.id),quality:{version:2,decision:'filtered',reason:'未达门槛：转发 1<5'},processedHash:item.contentHash,analysisFingerprint:analysisFingerprint([rule]),attempts:3});
    const collector=new Collector(store,{request:async()=>{throw Error('No network');}},'',false);
    const reviewed:string[]=[];
    await new Runner(store,collector,{analyze:async evidence=>{reviewed.push(...evidence.map(ev=>ev.id));return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};}}).scan('重新核实');
    assert.deepEqual(reviewed,[item.id]);
  }finally{store.close();}
});

test('公开发现不等待慢速 X；一轮读取六条搜索原文并限制读取并发',async()=>{
  const store=setup([x,web]);try{
    let publicStarted=false,active=0,peak=0,reads=0;
    const collector=new Collector(store,{request:async()=>{throw Error('No network');}},'',false);
    collector.x=async source=>{
      await new Promise(resolve=>setTimeout(resolve,30));
      assert.equal(publicStarted,true,'X 返回前应已发起独立公开搜索');
      return collector.result(source,[],'empty');
    };
    collector.web=async source=>{
      if(publicStarted)return collector.result(source,[],'empty');
      publicStarted=true;
      return collector.result(source,Array.from({length:6},(_,i)=>makeEvidence(source,{url:`https://example.com/news/${i}`,title:'Coding update',text:'Search snippet',contentKind:'snippet'})));
    };
    collector.enrich=async item=>{
      active++;peak=Math.max(peak,active);reads++;
      await new Promise(resolve=>setTimeout(resolve,10));active--;
      return applyQuality({...item,original:true,contentKind:'article',author:'Publisher',publishedAt:date,text:body});
    };
    let count=0;
    const run=await new Runner(store,collector,{analyze:async evidence=>{count+=evidence.length;return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};}}).scan('测试');
    assert.equal(count,6);assert.equal(reads,6);assert.ok(peak>1&&peak<=3,`读取并发 ${peak}`);
    assert.ok(!run?.sources.some(row=>row.status==='failed'));
  }finally{store.close();}
});

test('AI 输出截断后拆小批次继续，成功材料不丢失且不重复消耗重试次数',async()=>{
  const store=setup([x]);try{
    for(let i=0;i<6;i++)ingest(store,post(String(i),{likes:10,reposts:5,views:500,authorFollowers:100}));
    const collector=new Collector(store,{request:async()=>{throw Error('No network');}},'',false);
    const reviewed:string[]=[];const batches:number[]=[];
    const run=await new Runner(store,collector,{analyze:async evidence=>{
      batches.push(evidence.length);
      if(evidence.length>3)throw Error('AI 输出被截断或为空，候选内容将保留');
      reviewed.push(...evidence.map(ev=>ev.id));return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};
    }}).scan('重新核实');
    assert.equal(new Set(reviewed).size,6);assert.equal(run?.analyzed,6);
    assert.deepEqual(batches,[6,3,3]);
    assert.ok(store.list<Candidate>('candidates').every(item=>item.attempts===1));
  }finally{store.close();}
});

test('拆分 AI 批次始终保留推文关联的旧原文，避免新推文刷新旧事件',async()=>{
  const store=setup([x]);try{
    for(let i=0;i<2;i++)ingest(store,post(String(i),{outboundUrls:[`https://example.com/${i}/a`,`https://example.com/${i}/b`]}));
    const collector=new Collector(store,{request:async()=>{throw Error('No network');}},'',false);
    collector.x=async source=>collector.result(source,[],'empty');
    collector.refreshMetrics=async source=>collector.result(source,[],'cached');
    collector.linked=async item=>(item.outboundUrls||[]).map(url=>applyQuality(makeEvidence(web,{url,title:'Old release',text:body,author:'Publisher',publishedAt:'2020-01-01T00:00:00Z',original:true,contentKind:'article'})));
    const sizes:number[]=[];
    const run=await new Runner(store,collector,{analyze:async evidence=>{
      sizes.push(evidence.length);
      for(const item of evidence.filter(ev=>ev.sourceKind==='x'))for(const url of item.outboundUrls||[])assert.ok(evidence.some(ev=>ev.finalUrl===url),'旧原文不能在拆分中丢失');
      if(evidence.length>3)throw Error('AI 输出被截断或为空，候选内容将保留');
      return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};
    }}).scan('测试');
    assert.deepEqual(sizes,[6,3,3]);assert.equal(run?.analyzed,6);
  }finally{store.close();}
});

test('同一平台并发读取仍按请求间隔排队，其他平台独立通行',async()=>{
  const throttle=new Throttle();await throttle.wait('video',20);
  const times=await Promise.all(Array.from({length:3},async()=>{await throttle.wait('video',20);return Date.now();}));
  assert.ok(times[2]-times[0]>=25,'不能让并发等待者在同一时刻集中请求');
  const started=Date.now();await throttle.wait('other',1000);assert.ok(Date.now()-started<500);
});
