import { fixtureAssessment } from './analysis-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Candidate, Evidence, Rule, Source } from '../shared/types.js';
import { nonTwitterDiscovery, platformOf } from '../shared/discovery.js';
import { defaultSignal } from '../shared/freshness.js';
import { applyQuality, bindVideoEvidence, selectCandidates } from '../server/quality.js';
import { article, makeEvidence } from '../server/parse.js';
import { assignedJSON } from '../server/publication.js';
import { discoverySearches } from '../server/search.js';
import { analysisSchema, validateBatch } from '../server/ai.js';
import { Store } from '../server/db.js';
import { Collector, ingest } from '../server/sources.js';
import { Runner } from '../server/runner.js';

const date=new Date(Date.now()-60000).toISOString();
const web:Source={id:'bing',name:'Bing',kind:'web',url:'https://www.bing.com/search',enabled:true,official:false};
const x:Source={...web,id:'twitter',name:'Twitter',kind:'x',url:'https://api.twitterapi.io'};
const bili:Source={...web,id:'bilibili',name:'B站',format:'bilibili',url:'https://api.bilibili.com/x/web-interface/search/all/v2'};
const weibo:Source={...web,id:'weibo',name:'微博',format:'weibo',url:'https://weibo.com/'};
const rule:Rule={id:'rule',name:'AI',query:'AI coding',kind:'topic',enabled:true,notify:false,createdAt:date,baselineAt:date,lastRunAt:null,nextRunAt:date};
const body='The publisher released a new code model with concrete improvements and downloadable project files. '.repeat(2);
const item=(source=web,i=1,extra:Partial<Evidence>={})=>applyQuality(makeEvidence(source,{url:`https://example.com/news/${i}`,title:'New coding model release',text:body,author:'News publisher',publishedAt:date,original:true,contentKind:'article',...extra}));
const post=(i=1)=>item(x,i,{url:`https://x.com/author/status/${i}`,externalId:String(i),contentKind:'post',postType:'original',likes:10,reposts:5,views:500,authorFollowers:100});
const video=(i=1)=>item(bili,i,{url:`https://www.bilibili.com/video/BVtest${i}/`,contentKind:'description',author:'Video creator'});
const status=(i=1)=>item(weibo,i,{url:`https://weibo.com/123/${i}`,contentKind:'post',author:'Post author'});
const candidate=(ev:Evidence):Candidate=>({...ev,attempts:0,processedHash:null});
const checked=(ev:Evidence)=>validateBatch(analysisSchema.parse({events:[{title:ev.title,summary:'A new model release with concrete improvements.',entity:'coding-model',version:'1',eventType:'release',occurredAt:null,isNewsworthy:true,isNewEvent:true,status:'confirmed',reason:'Source material',attention:60,attentionReason:'New capabilities', importance: 'medium', importanceReason: 'Fixture impact',tags:[],evidenceIds:[ev.id],ruleIds:[rule.id],ruleAssessments:[fixtureAssessment(ev,rule)],existingEventId:null}],excludedEvidenceIds:[]}),[ev],[rule],[]).signals[0];

test('可读网页、微博原帖与 B站简介可独立待核实，保留实际视频链接',()=>{
  for(const ev of [item(),video(),status()]){
    assert.equal(nonTwitterDiscovery(ev),true);
    const signal=checked(ev);assert.equal(signal.status,'pending');assert.equal(defaultSignal(signal),true);
    assert.equal(signal.evidence[0].finalUrl,ev.finalUrl);
  }
  assert.equal(platformOf(video()),'bilibili');assert.equal(platformOf(status()),'weibo');
});

test('搜索摘要、微博页面描述、无日期和无作者的视频不能独立入选',()=>{
  for(const ev of [item(web,1,{contentKind:'snippet',original:false}),{...status(),contentKind:'description' as const},{...video(),publishedAt:null},{...video(),author:''},{...video(),author:'www.bilibili.com'},{...video(),publishedAt:'2020-01-01T00:00:00Z'},{...video(),finalUrl:'https://www.bilibili.com/'}]){
    assert.equal(nonTwitterDiscovery(ev),false);assert.equal(defaultSignal(checked(ev)),false);
  }
  assert.equal(nonTwitterDiscovery({...post(),sourceKind:'web',sourceId:'bing',likes:0}),false);
});

test('候选充足时 21 条 Twitter 与 9 条其他平台，跨引擎同一原文只占一份',()=>{
  const others=[...Array.from({length:20},(_,i)=>video(i)),...Array.from({length:20},(_,i)=>status(i)),...Array.from({length:20},(_,i)=>item(web,i))];
  const inputs=[...Array.from({length:40},(_,i)=>post(i)),...others,...others.map(ev=>({...ev,id:'alias-'+ev.id,sourceId:'baidu'}))].map(candidate);
  const selected=selectCandidates(inputs,30);assert.equal(selected.length,30);assert.equal(selected.filter(ev=>ev.sourceKind==='x').length,21);
  assert.equal(selected.filter(ev=>platformOf(ev)==='bilibili').length,3);assert.equal(selected.filter(ev=>platformOf(ev)==='weibo').length,3);assert.equal(selected.filter(ev=>platformOf(ev)==='web').length,3);
  assert.equal(new Set(selected.map(ev=>ev.finalUrl)).size,30);
  assert.equal(selectCandidates(inputs.filter(ev=>ev.sourceKind==='x'),30).length,30);
  assert.equal(selectCandidates(inputs.filter(ev=>ev.sourceKind!=='x'),30).length,30);
});

test('同一作者的无关推文不能挂上视频，明确引用视频链接时可合并',()=>{
  const v=video();const p=post();
  assert.deepEqual(bindVideoEvidence([v]),[v]);assert.deepEqual(bindVideoEvidence([v,p]),[p]);
  assert.equal(bindVideoEvidence([v,{...p,outboundUrls:[v.finalUrl]}]).length,2);
  const request=analysisSchema.parse({events:[{title:p.title,summary:'A model update.',entity:'model',version:'1',eventType:'release',occurredAt:date,isNewsworthy:true,isNewEvent:true,status:'pending',reason:'Different subject',attention:40,attentionReason:'Update', importance: 'medium', importanceReason: 'Fixture impact',tags:[],evidenceIds:[p.id,v.id],ruleIds:[rule.id],ruleAssessments:[fixtureAssessment(p,rule)],existingEventId:null}],excludedEvidenceIds:[]});
  const result=validateBatch(request,[p,v],[rule],[]);assert.equal(result.signals[0].evidence.some(ev=>platformOf(ev)==='bilibili'),false);
});

test('其他监控范围暂未参与分析时，不能把原有视频事件改成未命中而隐藏',()=>{
  const v=video();const prior=checked(v);
  const request=analysisSchema.parse({events:[{title:v.title,summary:'Previously collected video',entity:prior.entity,version:prior.version,eventType:prior.eventType,occurredAt:date,isNewsworthy:true,isNewEvent:false,status:'rejected',reason:'No match in this run',attention:40,attentionReason:'Video', importance: 'medium', importanceReason: 'Fixture impact',tags:[],evidenceIds:[v.id],ruleIds:[],existingEventId:prior.id}],excludedEvidenceIds:[]});
  const result=validateBatch(request,[v],[{...rule,id:'different'}],[prior]);assert.deepEqual(result.signals[0],prior);assert.equal(defaultSignal(result.signals[0]),true);
});

test('采集只执行到期规则，AI 评估使用全部已启用规则，避免已有线索被另一轮范围覆盖',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);store.put('sources',bili.id,bili);
    store.put('rules',rule.id,rule);store.put('rules','creator',{...rule,id:'creator',query:'creator videos',nextRunAt:new Date(Date.now()+3600000).toISOString()});
    store.put('rules','paused',{...rule,id:'paused',enabled:false});ingest(store,video());let checked=false;
    const collector=new Collector(store,{request:async()=>{throw Error('No request');}},'',false);collector.videoSearch=async source=>collector.result(source,[],'empty');
    const run=await new Runner(store,collector,{analyze:async(evidence,rules)=>{checked=true;assert.deepEqual(rules.map(r=>r.id).sort(),['creator','rule']);return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};}}).scan('定时检查');
    assert.equal(checked,true);assert.deepEqual(run?.ruleIds,[rule.id]);
  }finally{store.close();}
});

test('多轮独立发现轮转关注规则，暂停平台不查询，作者视频查询保留作者名',()=>{
  const rules=[rule,{...rule,id:'creator',query:'程序员鱼皮的视频或者编程导航内容'}];
  const jobs=discoverySearches(rules,[web,bili,weibo],6,0);
  assert.equal(jobs[0].platform,'bilibili');assert.equal(jobs[0].query,'程序员鱼皮');
  assert.equal(new Set(jobs.map(job=>job.platform)).size,3);
  assert.equal(discoverySearches(rules,[web,{...bili,enabled:false},weibo],6).some(job=>job.platform==='bilibili'),false);
  assert.equal(discoverySearches(rules,[web,bili,weibo],6,1)[0].platform,'weibo');
});

test('B站公开接口解析真实作者、发布时间与链接；简介读取失败不丢失已取得材料',async()=>{
  const store=new Store(':memory:');try{
    let calls=0;
    const collector=new Collector(store,{request:async(url,options)=>{
      calls++;assert.equal(options?.headers?.Cookie,undefined);
      if(new URL(url).pathname==='/x/web-interface/view')return {status:503,url,headers:{},text:'Detail temporarily unavailable'};
      assert.equal(new URL(url).searchParams.get('order'),'pubdate');
      return {status:200,url,headers:{},text:JSON.stringify({code:0,data:{result:[{bvid:'BVabc123',title:'<em>New model</em> release',author:'作者',mid:123,description:body,pubdate:Math.floor(Date.parse(date)/1000),play:50},{bvid:'BVold123',title:'Old release',author:'作者',description:body,pubdate:1577836800}]}})};
    }},'',false);
    const typed={...bili,url:'https://api.bilibili.com/x/web-interface/search/type'};
    const result=await collector.videoSearch(typed,'model');assert.equal(result.items.length,2);assert.equal(nonTwitterDiscovery(result.items[0]),true);assert.equal(nonTwitterDiscovery(result.items[1]),false);
    assert.equal(result.items[0].author,'作者');assert.equal(result.items[0].authorId,'123');assert.equal(result.items[0].finalUrl,'https://www.bilibili.com/video/BVabc123/');assert.equal(result.items[0].views,50);
    assert.equal((await collector.enrich(result.items[0])).original,true);assert.equal(calls,2);
    assert.equal((await collector.enrich(result.items[0])).original,true);assert.equal(calls,2);
    await collector.videoSearch(typed,'model');assert.equal(calls,2);
  }finally{store.close();}
});

test('B站公开接口拒绝访问时明确失败，不伪装为零条成功',async()=>{
  const store=new Store(':memory:');try{
    const collector=new Collector(store,{request:async url=>({status:200,url,headers:{},text:JSON.stringify({code:-412,message:'访问校验',data:null})})},'',false);
    await assert.rejects(collector.videoSearch(bili,'model'),/公开搜索不可用.*-412/);
  }finally{store.close();}
});

test('平台页面只解析字面 JSON，不执行脚本，文章修改时间不当作新发布',()=>{
  const data={videoData:{bvid:'BVabc123',desc:body+' escaped " } [ text',pubdate:Math.floor(Date.parse(date)/1000),owner:{name:'作者',mid:123},stat:{view:50}}};
  const html='<title>New video</title><script>window.__INITIAL_STATE__='+JSON.stringify(data)+';throw Error("must not execute")</script>';
  assert.deepEqual(assignedJSON(html,'window.__INITIAL_STATE__'),data);
  const parsed=article(html,'https://www.bilibili.com/video/BVabc123/');assert.equal(parsed.author,'作者');assert.equal(parsed.contentKind,'description');assert.ok(parsed.text.includes('escaped " } [ text'));assert.ok(parsed.publishedAt);
  assert.equal(assignedJSON('window.__INITIAL_STATE__=getData()','window.__INITIAL_STATE__'),null);
  const modified=article('<meta property="article:modified_time" content="'+date+'"><article>'+body+'</article>','https://example.com/news');assert.equal(modified.publishedAt,null);
  assert.throws(()=>article(html.replace('BVabc123','BVother123'),'https://www.bilibili.com/video/BVabc123/'));
});

test('微博读取实际正文、作者和北京时间；只有页面描述不冒充原帖',()=>{
  const full=article('<div class="c"><a class="nk">开发者</a><span class="ctt">'+body+'</span><span class="ct">2026-10-15 12:30 来自 Web</span></div>','https://weibo.cn/123/abc');
  assert.equal(full.author,'开发者');assert.equal(full.contentKind,'post');assert.equal(full.publishedAt,'2026-10-15T04:30:00.000Z');
  const description=article('<meta name="description" content="'+body+'">','https://weibo.com/123/abc');assert.equal(description.contentKind,'description');assert.equal(description.publishedAt,null);
});

test('独立发现与补证共用每轮请求上限，一路失败仍分析其他合格来源',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);
    for(const source of [web,bili,weibo])store.put('sources',source.id,source);
    store.put('rules',rule.id,rule);store.put('state','settings',{...store.settings(),searchPerRunLimit:3});
    const urls:string[]=[];let analyzed:Evidence[]=[];
    const collector=new Collector(store,{request:async url=>{
      urls.push(url);
      if(url.includes('api.bilibili.com'))return {status:200,url,headers:{},text:JSON.stringify({code:0,data:{result:[{result_type:'video',data:[{bvid:'BVabc123',title:'Model release',author:'作者',description:body,pubdate:Math.floor(Date.parse(date)/1000)}]}]}})};
      return {status:403,url,headers:{},text:'Access denied'};
    }},'',false);
    const run=await new Runner(store,collector,{analyze:async evidence=>{analyzed.push(...evidence);return {signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};}}).scan('测试');
    assert.ok(analyzed.some(ev=>platformOf(ev)==='bilibili'));assert.ok(urls.length<=3);assert.equal(run?.status,'partial');assert.ok(run?.sources.some(row=>row.status==='failed'));
    assert.ok(run?.sources.some(row=>row.purpose==='discovery'&&row.sourceId==='bilibili'));
  }finally{store.close();}
});

test('原生 B站请求不占引擎轮转位置，微博查询不会每次固定到同一个引擎',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);
    for(const source of [bili,weibo,web,{...web,id:'baidu'},{...web,id:'sogou'}])store.put('sources',source.id,source);
    store.put('rules',rule.id,rule);store.put('rules','other',{...rule,id:'other',query:'OpenAI'});
    const collector=new Collector(store,{request:async()=>{throw Error('No network');}},'',false);const used:string[]=[];
    collector.videoSearch=async source=>collector.result(source,[],'empty');
    collector.web=async source=>{used.push(source.id);return collector.result(source,[],'empty');};
    await new Runner(store,collector,{analyze:async()=>{throw Error('No candidates');}}).scan('测试');
    assert.equal(used.length,8);assert.equal(new Set(used.slice(0,3)).size,3);assert.notEqual(used[0],used[2]);
  }finally{store.close();}
});

test('Twitter 补充证据较多时仍安排其他平台，AI 总材料不超原有上限',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);
    for(const source of [x,bili,weibo])store.put('sources',source.id,source);
    store.put('rules',rule.id,rule);store.put('state','settings',{...store.settings(),candidatePerRunLimit:10});
    for(let i=0;i<10;i++){
      const ev={...post(i),outboundUrls:[`https://example.com/proof/a${i}`,`https://example.com/proof/b${i}`]};ingest(store,ev);
      for(const url of ev.outboundUrls)ingest(store,item(web,i,{url,sourceId:x.id}));
    }
    ingest(store,video());ingest(store,status());const analyzed:Evidence[]=[];
    const run=await new Runner(store,new Collector(store,{request:async()=>{throw Error('Recheck must not request');}},'',false),{analyze:async evidence=>{analyzed.push(...evidence);return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};}}).scan('重新核实');
    assert.ok(analyzed.some(ev=>platformOf(ev)==='bilibili'));assert.ok(analyzed.some(ev=>platformOf(ev)==='weibo'));assert.ok(analyzed.length<=10);assert.equal(run?.analyzed,analyzed.length);
  }finally{store.close();}
});

test('没有合格 Twitter 时，其他平台可使用整轮材料额度，不被少量主候选限制补证空间',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);for(const source of [web,bili])store.put('sources',source.id,source);
    store.put('rules',rule.id,rule);store.put('state','settings',{...store.settings(),candidatePerRunLimit:6});ingest(store,video(1));ingest(store,video(2));
    const collector=new Collector(store,{request:async()=>{throw Error('No network');}},'',false);collector.videoSearch=async source=>collector.result(source,[],'empty');collector.enrich=async ev=>ev;
    let i=10;collector.web=async(source,query)=>collector.result(source,query.endsWith('official announcement')?[item(web,i++),item(web,i++)]:[],'success');
    const analyzed:Evidence[]=[];await new Runner(store,collector,{analyze:async evidence=>{analyzed.push(...evidence);return{signals:[],excludedEvidenceIds:evidence.map(ev=>ev.id)};}}).scan('测试');
    assert.equal(analyzed.filter(ev=>platformOf(ev)==='bilibili').length,2);assert.equal(analyzed.length,6);
  }finally{store.close();}
});

test('迁移不改变暂停的规则、平台开关或原始记录，合格旧网页重新排队一次',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'multiplatform-migration-'));const filename=path.join(directory,'test.sqlite');
  let store=new Store(filename);try{
    store.put('rules',rule.id,{...rule,enabled:false});store.put('sources',bili.id,{...bili,enabled:false});
    const ev=candidate(item());store.put('candidates',ev.id,{...ev,attempts:3,processedHash:ev.contentHash});
    const mixed={...checked(post()),evidence:[post(),video()]};store.put('events',mixed.id,mixed);store.remove('state','videoIntroBindingV1');
    store.remove('state','multiPlatformDiscoveryV1');store.close();store=new Store(filename);
    assert.equal(store.get<Source>('sources','weibo')?.format,'weibo');assert.equal(store.get<Rule>('rules',rule.id)?.enabled,false);assert.equal(store.get<Source>('sources',bili.id)?.enabled,false);
    const restored=store.get<Candidate>('candidates',ev.id)!;assert.equal(restored.text,ev.text);assert.equal(restored.attempts,0);assert.equal(restored.processedHash,null);assert.equal(store.list('multiplatform-audit-v1').length,1);
    assert.equal(store.get<{evidence:Evidence[]}>('events',mixed.id)?.evidence.length,1);assert.equal(store.list('video-binding-audit-v1').length,1);
    store.put('candidates',ev.id,{...restored,attempts:1});store.close();store=new Store(filename);assert.equal(store.get<Candidate>('candidates',ev.id)?.attempts,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
