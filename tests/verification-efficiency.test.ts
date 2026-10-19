import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer, REASONING_POLICY_VERSION, analysisSchema, parseAnalysisOutput, validateBatch, type Analysis } from '../server/ai.js';
import { Runner } from '../server/runner.js';
import { Collector, ingest } from '../server/sources.js';
import { Store } from '../server/db.js';
import { makeEvidence } from '../server/parse.js';
import { applyQuality } from '../server/quality.js';
import { analysisFingerprint } from '../shared/relevance.js';
import { fixtureAssessment } from './analysis-fixture.js';
import type { Candidate, Evidence, Rule, Source } from '../shared/types.js';

const date=new Date(Date.now()-60000).toISOString();
const web:Source={id:'bing',name:'Bing',kind:'web',url:'https://www.bing.com/search',enabled:true,official:false};
const x:Source={...web,id:'twitter',kind:'x',url:'https://api.twitterapi.io'};
const rule:Rule={id:'rule',name:'Coding',query:'AI coding agents',kind:'topic',enabled:true,notify:false,createdAt:date,baselineAt:date,lastRunAt:null,nextRunAt:date};
const text='The project released a new coding agent with executable code examples and improved repository task completion. '.repeat(2);
const post=(id='1')=>applyQuality(makeEvidence(x,{url:`https://x.com/author/status/${id}`,externalId:id,title:'New coding agent release',text,author:'author',publishedAt:date,contentKind:'post',postType:'original',original:true,likes:10,reposts:5,views:500,authorFollowers:100}));
const official=()=>applyQuality(makeEvidence(web,{url:'https://openai.com/news/coding-agent',title:'New coding agent release',text,author:'OpenAI',publishedAt:date,contentKind:'article',original:true,official:true}));
function event(ev:Evidence,status:'confirmed'|'pending'|'rejected'='pending'):Analysis['events'][number] {
  return {title:ev.title,summary:'The project released new coding agent capabilities.',entity:'project',version:'1',eventType:'release',occurredAt:date,isNewsworthy:true,isNewEvent:true,status,reason:'Source material',attention:50,attentionReason:'New capabilities',importance:'medium',importanceReason:'Project update',tags:[],evidenceIds:[ev.id],ruleIds:[rule.id],ruleAssessments:[fixtureAssessment(ev,rule)],existingEventId:null};
}
function setup(sources:Source[]=[x,web]) {
  const store=new Store(':memory:');
  for(const source of store.list<Source>('sources'))store.remove('sources',source.id);
  for(const source of sources)store.put('sources',source.id,source);
  store.put('rules',rule.id,rule);return store;
}
function pending(store:Store,ev=post(),attempts=0) {
  ingest(store,ev);
  const signal=validateBatch(analysisSchema.parse({events:[event(ev)],excludedEvidenceIds:[]}),[ev],[rule],[]).signals[0];
  store.put('events',signal.id,signal);
  store.put('candidates',ev.id,{...store.get<Candidate>('candidates',ev.id)!,processedHash:null,attempts,analysisFingerprint:analysisFingerprint([rule])});
  return signal;
}
function collectorFor(store:Store) {
  const collector=new Collector(store,{request:async()=>{throw Error('Unexpected network');}},'',false);
  collector.x=async source=>collector.result(source,[],'empty');
  collector.refreshMetrics=async source=>collector.result(source,[],'cached');
  collector.web=async source=>collector.result(source,[],'empty');
  return collector;
}

test('官方原文已确认时，合并同一事件的待核实材料不再丢失确认结论',()=>{
  const p=post(),o=official();
  for(const order of [[p,o],[o,p]]) {
    const materials=Object.fromEntries(order.map(ev=>[ev.id,{events:[event(ev,ev.official?'confirmed':'pending')],exclusion:null}]));
    const parsed=parseAnalysisOutput({materials},order,[rule]);
    assert.equal(parsed.events.length,1);assert.equal(parsed.events[0].status,'confirmed');
    assert.equal(validateBatch(parsed,order,[rule],[]).signals[0].status,'confirmed');
  }
});

test('存在明确否定、无官方证据或事件时间不符时仍不能靠合并变成已核实',()=>{
  const p=post(),o=official();
  const output=(a:Evidence,b:Evidence,status:'pending'|'rejected')=>parseAnalysisOutput({materials:{[a.id]:{events:[event(a,status)],exclusion:null},[b.id]:{events:[event(b,'confirmed')],exclusion:null}}},[a,b],[rule]);
  assert.equal(validateBatch(output(p,o,'rejected'),[p,o],[rule],[]).signals[0].status,'pending');
  const unofficial={...o,official:false,url:'https://example.com/news/agent',finalUrl:'https://example.com/news/agent'};
  assert.equal(validateBatch(output(p,unofficial,'pending'),[p,unofficial],[rule],[]).signals[0].status,'pending');
  const old={...o,publishedAt:new Date(Date.now()-3*86400000).toISOString()};
  assert.equal(validateBatch(output(p,old,'pending'),[p,old],[rule],[]).signals[0].status,'pending');
});

test('旧待核实候选即使三次审核未解决，补到新官方原文后仍可升级',async()=>{
  const store=setup();try{
    const p=post();pending(store,p,3);const collector=collectorFor(store);let checks=0;
    collector.web=async(source,query)=>collector.result(source,query.endsWith('official announcement')?[official()]:[],'success');
    const runner=new Runner(store,collector,{analyze:async(evidence,rules,prior)=>{
      checks++;assert.ok(evidence.some(ev=>ev.official));
      const data=analysisSchema.parse({events:[{...event(p,'confirmed'),evidenceIds:evidence.map(ev=>ev.id),existingEventId:prior[0].id}],excludedEvidenceIds:[]});
      return validateBatch(data,evidence,rules,prior);
    }});
    await runner.scan('测试');
    assert.ok(checks>0);assert.equal(store.list<{status:string}>('events')[0].status,'confirmed');
  }finally{store.close();}
});

test('待核实证据未变化时不反复调用 AI，手动重新核实仍可强制复审',async()=>{
  const store=setup([x]);try{
    const p=post();pending(store,p);let checks=0;
    const runner=new Runner(store,collectorFor(store),{analyze:async(evidence,rules,prior)=>{
      checks++;return validateBatch(analysisSchema.parse({events:[{...event(p),existingEventId:prior[0].id}],excludedEvidenceIds:[]}),evidence,rules,prior);
    }});
    await runner.scan('测试');await runner.scan('测试');assert.equal(checks,1);
    await runner.scan('重新核实');assert.equal(checks,2);
  }finally{store.close();}
});

test('补证复用已保存的引用官方原文，非 X 材料的官方外链也可读取',async()=>{
  const store=setup();try{
    const o=official(),p={...post(),outboundUrls:[o.finalUrl]};let reads=0;
    const collector=collectorFor(store);
    collector.enrich=async item=>{reads++;return {...o,id:item.id,sourceId:item.sourceId};};
    const cached=await collector.linked(p,[o]);assert.equal(reads,0);assert.equal(cached[0].original,true);
    const article={...p,sourceKind:'web' as const,contentKind:'article' as const,url:'https://example.com/news/agent',finalUrl:'https://example.com/news/agent'};
    const linked=await collector.linked(article);assert.equal(reads,1);assert.equal(linked[0].official,true);
  }finally{store.close();}
});

test('证据未变时跳过审核，新增已缓存官方原文会使跳过记录失效并升级',async()=>{
  const store=setup();try{
    const p=post();pending(store,p);let checks=0;
    const runner=new Runner(store,collectorFor(store),{analyze:async(evidence,rules,prior)=>{
      checks++;
      return validateBatch(analysisSchema.parse({events:[{...event(p,evidence.some(ev=>ev.official)?'confirmed':'pending'),existingEventId:prior[0].id,evidenceIds:evidence.map(ev=>ev.id)}],excludedEvidenceIds:[]}),evidence,rules,prior);
    }});
    await runner.scan('测试');await runner.scan('测试');assert.equal(checks,1);
    const saved=store.get<Candidate>('candidates',p.id)!;
    store.put('candidates',p.id,{...saved,attempts:3,outboundUrls:[official().finalUrl]});ingest(store,official());
    await runner.scan('测试');assert.equal(checks,2);assert.equal(store.list<{status:string}>('events')[0].status,'confirmed');
  }finally{store.close();}
});

test('统一信息流优先发现，仍在原上限中保留少量补证请求',async()=>{
  const store=setup();try{
    store.put('state','settings',{...store.settings(),searchPerRunLimit:6});
    for(let i=1;i<6;i++)store.put('rules','extra-'+i,{...rule,id:'extra-'+i});
    for(let i=0;i<3;i++){
      const signal=pending(store,post(String(i)));
      store.remove('events',signal.id);store.put('events','pending-'+i,{...signal,id:'pending-'+i,eventKey:'pending-'+i});
    }
    let discovery=0,verification=0;const collector=collectorFor(store);
    collector.web=async(source,query)=>{
      if(query.endsWith('official announcement'))verification++;else discovery++;
      return collector.result(source,[],'empty');
    };
    await new Runner(store,collector,{analyze:async evidence=>({signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)})}).scan('测试');
    assert.equal(discovery,5);assert.equal(verification,1);assert.equal(discovery+verification,6);
  }finally{store.close();}
});

test('整轮真实 Analyzer 契约将旧待核实升级，之后不重复核实且不提高调用限额',async()=>{
  const store=setup();try{
    const p=post();pending(store,p,3);const collector=collectorFor(store);
    collector.web=async(source,query)=>collector.result(source,query.endsWith('official announcement')?[official()]:[],'success');
    store.put('state','settings',{...store.settings(),model:'fixture',aiDailyLimit:1});
    store.put('state','modelChecked',{model:'fixture',at:Date.now(),reasoningEffort:null,reasoningPolicyVersion:REASONING_POLICY_VERSION});
    let completions=0;
    const analyzer=new Analyzer(store,{request:async(url,options)=>{
      assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');completions++;
      const request=JSON.parse(options!.body!);const input=JSON.parse(request.messages[1].content);
      const materials=Object.fromEntries((input.evidence as Evidence[]).map(ev=>[ev.id,{events:[{...event(ev,ev.official?'confirmed':'pending'),existingEventId:input.priorEvents[0].id}],exclusion:null}]));
      return{status:200,url,headers:{},text:JSON.stringify({choices:[{message:{content:JSON.stringify({materials})},finish_reason:'stop'}],usage:{total_tokens:100}})};
    }},'fixture-key');
    const runner=new Runner(store,collector,analyzer);
    const run=await runner.scan('测试');
    assert.equal(run?.analyzed,2);assert.equal(store.list<{status:string}>('events')[0].status,'confirmed');
    await runner.scan('测试');assert.equal(completions,1);assert.equal(store.usage().aiRequests,1);assert.equal(store.settings().aiDailyLimit,1);
  }finally{store.close();}
});
