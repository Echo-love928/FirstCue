import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.js';
import { dashboard } from '../server/app.js';
import { collectedSignals, discoveryMatches } from '../server/collected-feed.js';
import { makeEvidence } from '../server/parse.js';
import { applyQuality } from '../server/quality.js';
import { ingest, Collector } from '../server/sources.js';
import { Runner } from '../server/runner.js';
import { currentSignal, historicalSignal } from '../shared/freshness.js';
import { eventTime, publishedTime } from '../shared/feed.js';
import { ruleFingerprint } from '../shared/relevance.js';
import type { Candidate, Rule, Source } from '../shared/types.js';

const now=Date.now(),date=new Date(now-60000).toISOString();
const web:Source={id:'bing',name:'Bing',kind:'web',url:'https://www.bing.com/search',enabled:true,official:false};
const x:Source={...web,id:'twitter',kind:'x',url:'https://api.twitterapi.io'};
const rule:Rule={id:'rule',name:'OpenAI',query:'OpenAI相关内容',kind:'keyword',enabled:true,notify:false,createdAt:date,baselineAt:date,nextRunAt:date,lastRunAt:null};
const raw=(patch:Partial<Candidate>={}):Candidate=>({...applyQuality(makeEvidence(web,{url:'https://example.com/news/openai',title:'OpenAI released a new coding model',text:'OpenAI released a new coding model with concrete improvements for code completion and repository tasks.',author:'Publisher',publishedAt:date,original:true,contentKind:'article'})),attempts:0,processedHash:null,...patch});

test('未配置 AI 或额度耗尽时，已采集相关信息无需等待核实即可显示',()=>{
  const store=new Store(':memory:');try{
    store.put('rules',rule.id,rule);ingest(store,raw());store.reserve('aiRequests',store.settings().aiDailyLimit,store.settings().aiDailyLimit);
    assert.equal(dashboard(store,false,true).events.length,1);
    const projected=dashboard(store,false,true).events[0];assert.equal(projected.discoveryOnly,true);assert.equal(projected.ruleAssessments,undefined);
    assert.equal(store.list('events').length,0);assert.equal(store.list('mail').length,0);assert.equal(store.list('feishu').length,0);
  }finally{store.close();}
});

test('低互动或缺少互动指标不挡住统一信息流，保留真实计数；回复仍排除',()=>{
  const ev=raw({...makeEvidence(x,{url:'https://x.com/author/status/1',title:'OpenAI released a new model',text:'OpenAI released a new coding model with executable examples and repository improvements.',publishedAt:date,author:'@author',original:true,postType:'original',likes:0,reposts:0,views:undefined,authorFollowers:1})});
  const values=collectedSignals([ev],[rule],[],now);assert.equal(values.length,1);assert.equal(values[0].evidence[0].likes,0);assert.equal(values[0].evidence[0].views,undefined);
  assert.equal(collectedSignals([{...ev,postType:'reply'}],[rule],[],now).length,0);
});

test('正文未读的搜索结果可展示原始摘要；未知日期使用首次发现，不冒充发布时间',()=>{
  const ev=raw({original:false,contentKind:'snippet',publishedAt:null,firstDiscoveredAt:date});
  const [item]=collectedSignals([ev],[rule],[],now);assert.equal(item.evidence[0].original,false);assert.equal(item.occurredAt,null);
  assert.equal(publishedTime(item,now),null);assert.equal(eventTime(item,now),Date.parse(date));
  const later=collectedSignals([{...ev,fetchedAt:new Date(now).toISOString()}],[rule],[],now)[0];assert.equal(later.firstSeenAt,date);
  assert.equal(currentSignal(item,now),true);
});

test('统一信息流去重已展示事件与跨引擎原文，过期信息不进入近五天',()=>{
  const ev=raw();const item=collectedSignals([ev,{...ev,id:'alias',sourceId:'sogou',discoveredBy:['sogou']}],[rule],[],now);assert.equal(item.length,1);assert.equal(item[0].evidence[0].discoveredBy?.length,2);
  assert.equal(collectedSignals([ev],[rule],item,now).length,0);
  const old=raw({publishedAt:new Date(now-6*86400000).toISOString()});const entry=collectedSignals([old],[rule],[],now)[0];
  assert.equal(currentSignal(entry,now),false);assert.equal(historicalSignal(entry,now),true);
});

test('后续搜索摘要不能覆盖已取得的正文及其真实发布时间',()=>{
  const store=new Store(':memory:');try{
    const full=raw();ingest(store,full);
    ingest(store,{...full,original:false,contentKind:'snippet',text:'OpenAI search snippet',contentHash:'snippet',publishedAt:null});
    const saved=store.get<Candidate>('candidates',full.id)!;assert.equal(saved.original,true);assert.equal(saved.text,full.text);assert.equal(saved.publishedAt,date);
  }finally{store.close();}
});

test('明确无关、错误版本和错误作者不因扩大展示范围而混入',()=>{
  assert.equal(collectedSignals([raw({relevanceExclusion:{evidenceId:'id',category:'unrelated',reason:'Unrelated'}})],[rule],[],now).length,0);
  assert.equal(discoveryMatches(raw({discoveryRules:{version:ruleFingerprint({...rule,query:'Claude Sonnet 4.6'})}}),{...rule,id:'version',query:'Claude Sonnet 4.6'}),false);
  assert.equal(discoveryMatches(raw({finalUrl:'https://www.bilibili.com/video/BVother/',author:'其他作者'}),{...rule,query:'B站up主 kate人不错的视频'}),false);
  assert.equal(discoveryMatches(raw({title:'Office agent',text:'A generic AI agent connects office apps.',author:'Publisher'}),{...rule,kind:'topic',query:'AI coding agents'}),false);
});

test('采集结果在耗时 AI 调用前已经进入统一信息流',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);
    store.put('sources',web.id,web);store.put('rules',rule.id,rule);
    const collector=new Collector(store,{request:async()=>{throw Error('No network');}},'',false);
    collector.web=async source=>collector.result(source,[raw()],'success');let observed=false;
    await new Runner(store,collector,{analyze:async evidence=>{
      observed=dashboard(store,false,true).events.length>0;
      return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};
    }}).scan('测试');assert.equal(observed,true);
  }finally{store.close();}
});
