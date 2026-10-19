import { fixtureAssessment } from './analysis-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Candidate, Evidence, Rule, Source } from '../shared/types.js';
import { assess, applyQuality, mergeEvidence, officialUrl, reviewHistorical, selectCandidates } from '../server/quality.js';
import { makeEvidence, parseFeed, parseListing, parseSearch, searchRedirect } from '../server/parse.js';
import { xQueryFor } from '../server/search.js';
import { Collector, ingest } from '../server/sources.js';
import { Store } from '../server/db.js';
import { Runner } from '../server/runner.js';
import { dashboard } from '../server/app.js';
import { analysisSchema, validateAnalysis } from '../server/ai.js';

const date = new Date(Date.now()-60000).toISOString();
const x:Source={id:'twitter',name:'X',kind:'x',url:'https://api.twitterapi.io',enabled:true,official:false};
const web:Source={id:'bing',name:'Bing',kind:'web',url:'https://www.bing.com/search',enabled:true,official:false};
const rule:Rule={id:'test',name:'Test',query:'OpenAI相关内容',kind:'keyword',enabled:true,notify:false,createdAt:date,baselineAt:null,lastRunAt:null,nextRunAt:date};
const post=(data:Partial<Evidence>={})=>makeEvidence(x,{url:'https://x.com/author/status/1',title:'Release',text:'A new release announcement from the project author.',externalId:'1',authorId:'author',publishedAt:date,postType:'original',original:true,likes:10,reposts:5,views:500,authorFollowers:100,...data});
const original=()=>makeEvidence(web,{url:'https://openai.com/news/release',title:'Release',text:'Original announcement with specific information about this model release. '.repeat(3),contentKind:'article',original:true,official:true,publishedAt:date});
const response=(tweets:unknown[],more=false,cursor:unknown=null)=>({status:200,url:x.url,headers:{},text:JSON.stringify({tweets,has_next_page:more,next_cursor:cursor})});

test('普通与官方回复、引用、纯转发和未知类型均过滤',()=>{
  assert.equal(assess(post({postType:'reply',inReplyToId:'parent'})).decision,'filtered');
  assert.equal(assess(post({postType:'repost',official:true})).decision,'filtered');
  assert.equal(applyQuality(post({postType:undefined})).postType,'unknown');
  assert.equal(applyQuality(post({postType:undefined})).original,false);
  assert.equal(assess(post({postType:'reply',official:true})).decision,'filtered');
  assert.equal(assess(post({postType:'reply',inReplyToId:'parent'}),[post({externalId:'parent'})]).decision,'filtered');
  assert.equal(assess(post({postType:'reply',inReplyToId:'parent',authorId:'another'}),[post({externalId:'parent'})]).decision,'filtered');
});
test('四项门槛同时满足，官方、蓝 V 或附外链均不能豁免',()=>{
  assert.equal(assess(post()).decision,'eligible');
  for(const extra of [{likes:0},{likes:4},{reposts:0},{views:199},{authorFollowers:49},{authorFollowers:undefined}]) {
    assert.equal(assess(post({...extra,official:true,authorBlueVerified:true,outboundUrls:['https://openai.com/news/release']})).decision,'filtered');
  }
  assert.equal(assess(post({text:'Nice tool!',likes:100000})).decision,'filtered');
});

test('共享平台按命名空间核验，不信任任意用户或伪装域名',()=>{
  for(const url of ['https://huggingface.co/random/model','https://huggingface.co/blog/community/post','https://huggingface.co/blog/random/post','https://github.com/impostor/repo/releases/1','https://openai.com.attacker.example/news']) assert.equal(officialUrl(url),false,url);
  for(const url of ['https://huggingface.co/Qwen/model','https://huggingface.co/deepseek-ai/model','https://github.com/deepseek-ai/DeepSeek-V3/releases/tag/1','https://www.anthropic.com/news/test']) assert.equal(officialUrl(url),true,url);
});
test('自定义 RSS 的官网链接不构成官方材料，实际源重定向后也必须验证归属',async()=>{
  const rss='<rss><channel><item><title>Fake release</title><link>https://openai.com/news/fake</link><pubDate>'+new Date(date).toUTCString()+'</pubDate><description>'+('Untrusted publisher claim '.repeat(40))+'</description></item></channel></rss>';
  const source={id:'custom',name:'Custom',kind:'rss' as const,url:'https://attacker.example/feed',enabled:true,official:false};
  assert.equal(applyQuality(parseFeed(rss,source)[0]).official,false);
  const store=new Store(':memory:');try{
    const trusted={...source,id:'openai',url:'https://openai.com/feed',official:true};
    const collector=new Collector(store,{request:async()=>({status:200,url:'https://attacker.example/feed',headers:{},text:rss})},'',false);
    const result=await collector.rss(trusted,0);assert.equal(result.items[0].official,false);assert.equal(applyQuality(result.items[0]).official,false);
  }finally{store.close();}
});
test('同一原文跨引擎合并，保留更完整原文和所有发现渠道',()=>{
  const first={...original(),original:false,text:'Snippet',sourceId:'bing'};
  const second={...original(),id:'second',sourceId:'sogou',discoveredBy:['sogou'],finalUrl:'https://www.openai.com/news/release/'};
  const values=mergeEvidence([first,second]); assert.equal(values.length,1); assert.equal(values[0].original,true); assert.deepEqual(values[0].discoveredBy?.sort(),['bing','sogou']);
});
test('相同原文不重复占候选名额，候选不足时由其他合格来源补足',()=>{
  const items:Candidate[]=[];
  for(let i=0;i<40;i++) for(const kind of ['x','web','rss'] as const){const value=kind==='x'?post({id:'x'+i,externalId:String(i),url:`https://x.com/author/status/${i}`,finalUrl:`https://x.com/author/status/${i}`,outboundUrls:['https://openai.com/news/release']}):{...original(),id:kind+i,sourceId:kind,sourceKind:kind};items.push({...applyQuality(value),attempts:0,processedHash:null});}
  const selected=selectCandidates(items,30);assert.equal(selected.length,30);assert.equal(selected.filter(item=>item.sourceKind==='x').length,29);
  assert.equal(selectCandidates(items.filter(item=>item.sourceKind==='x'),30).length,30);
});
test('Twitter 纯产品查询保留目标，不额外强制发布、更新',()=>{
  const query=xQueryFor(rule);assert.match(query,/OpenAI/);assert.doesNotMatch(query,/release OR update OR launch OR 发布 OR 更新/);
});

test('百度移动版读取目标 URL 和纯文本标题，搜狗去除查询导航且解析正文摘要',()=>{
  const baidu=parseSearch('<div class="c-result" data-log=\'{"mu":"https://example.com/news"}\'><h3><span>模型正式发布</span></h3><div data-module="abstract">发布摘要</div></div>',{...web,id:'baidu'},'https://m.baidu.com/s');
  assert.equal(baidu[0].url,'https://example.com/news'); assert.equal(baidu[0].text,'发布摘要');
  const sogou=parseSearch('<div class="vrwrap"><h3><a href="/link?url=token">模型发布报道</a></h3><p class="star-wiki">摘要</p></div>',{...web,id:'sogou'},'https://www.sogou.com/web'); assert.equal(sogou.length,1);assert.equal(sogou[0].text,'摘要');
});
test('官方发布列表不把导航、跨域链接、未知结构当作有效公告',()=>{
  const source={...web,id:'anthropic',url:'https://www.anthropic.com/news',kind:'rss' as const,official:true};
  const items=parseListing('<main><a href="/news">News</a><a href="https://attacker.example/news/fake">Fake news</a><a href="/news/release"><h2>Model Release</h2><time datetime="'+date+'">Today</time></a></main>',source,source.url);
  assert.equal(items.length,1);assert.equal(items[0].original,false);assert.equal(items[0].publishedAt,date);assert.throws(()=>parseListing('<main>unknown</main>',source,source.url));
});
test('搜狗跳转只读取字面目标并验证公共地址，不执行脚本或追踪私网',()=>{
  assert.equal(searchRedirect('<script>window.location.replace("https://example.com/news")</script>','https://www.sogou.com/link?url=token'),'https://example.com/news');
  assert.throws(()=>searchRedirect('<script>window.location.replace("http://127.0.0.1/private")</script>','https://www.sogou.com/link?url=token'));
  assert.equal(searchRedirect('<script>window.location.replace(getSecret())</script>','https://www.sogou.com/link?url=token'),null);
  assert.equal(searchRedirect('<script>window.location.replace("https://example.com/")</script>','https://attacker.example/link'),null);
});
test('Atom 更新时间独立保存，不冒充发布时间；未来条目不降为无日期候选',()=>{
  const source={...web,id:'vscode',kind:'rss' as const,official:true};
  const xml='<feed><entry><title>Update</title><link href="https://code.visualstudio.com/updates/test"/><updated>'+date+'</updated><summary>Release update</summary></entry></feed>';
  const item=parseFeed(xml,source)[0];assert.equal(item.publishedAt,null);assert.equal(item.updatedAt,date);
  assert.equal(parseFeed(xml.replace(date,new Date(Date.now()+86400000).toISOString()),source).length,0);
});
test('X 保存真实类型、展开链接；终页 null 游标正常，非终页 null 保留窗口并报错',async()=>{
  const tweet={id:'1',url:'https://x.com/author/status/1',text:'Announcement https://t.co/abc',createdAt:date,isReply:false,author:{id:'author',userName:'author'},entities:{urls:[{expanded_url:'https://openai.com/news/release'}]},likeCount:0};
  const store=new Store(':memory:');try{
    const urls:URL[]=[];const collector=new Collector(store,{request:async url=>{urls.push(new URL(url));return response([tweet]);}},'test-key',false);
    const value=await collector.x(x,'OpenAI',Date.now()-3600000);assert.equal(value.items[0].postType,'original');assert.equal(value.items[0].likes,0);assert.equal(value.items[0].outboundUrls?.[0],'https://openai.com/news/release');
    assert.match(urls[0].searchParams.get('query')!,/-filter:replies -filter:retweets/);assert.equal(value.result.status,'success');
    const broken=new Collector(store,{request:async()=>response([tweet],true,null)},'test-key',false);await assert.rejects(broken.x(x,'other',Date.now()-3600000),/游标/);assert.ok(store.list<Candidate>('candidates').length);
  }finally{store.close();}
});
test('普通原创读取其引用原文，未继承推文官方身份或编造发布时间',async()=>{
  const store=new Store(':memory:');try{
    const collector=new Collector(store,{request:async url=>({status:200,url,headers:{},text:'<meta property="article:published_time" content="'+date+'"><article><h1>Release</h1><p>'+('Original announcement '.repeat(12))+'</p></article>'})},'',false);
    const linked=await collector.linked(post({official:true,outboundUrls:['https://example.com/news/1']}));assert.equal(linked[0].original,true);assert.equal(linked[0].official,false);assert.equal(linked[0].publishedAt,date);
  }finally{store.close();}
});
test('只有补充回复不能独立确认或出现在事件列表',()=>{
  const ev=post({postType:'reply',official:true});const data=analysisSchema.parse({events:[{title:'Reply',summary:'Summary',entity:'model',version:'1',eventType:'release',occurredAt:date,isNewsworthy:true,isNewEvent:true,status:'confirmed',reason:'test',attention:20,attentionReason:'test', importance: 'medium', importanceReason: 'Fixture impact',tags:[],evidenceIds:[ev.id],ruleIds:[rule.id],ruleAssessments:[fixtureAssessment(ev,rule)],existingEventId:null}],excludedEvidenceIds:[]});
  const result=validateAnalysis(data,[ev],[rule],[])[0];assert.equal(result.status,'rejected');assert.equal(result.auditOnly,true);
});
test('历史重标保留原始记录、未知类型和规则，不删除数据，审计项从主列表移除',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'quality-migration-'));const filename=path.join(directory,'test.sqlite');
  try{
    let store=new Store(filename);const ev=post({postType:undefined});ingest(store,ev);store.put('rules',rule.id,{...rule,enabled:false});
    store.put('events','legacy',{id:'legacy',eventKey:'legacy',title:'Legacy',summary:'Old',entity:'m',version:'',eventType:'release',occurredAt:date,isNewsworthy:true,isNewEvent:true,status:'pending',reason:'old',attention:5,attentionReason:'old',tags:[],evidence:[ev],ruleIds:[rule.id],firstSeenAt:date,updatedAt:date});store.remove('state','qualityVersion');store.close();
    store=new Store(filename);assert.equal(store.list('candidates').length,1);assert.equal(store.list('events').length,1);assert.equal(store.list('event-audit-v2').length,1);assert.equal(dashboard(store).events.length,0);assert.equal(store.get<Rule>('rules',rule.id)?.enabled,false);assert.equal(store.list<Candidate>('candidates')[0].postType,'unknown');store.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('重新核实全程复用已存材料，不发出原文、搜索或 X 请求',async()=>{
  const store=new Store(':memory:');try{
    store.put('rules',rule.id,rule);ingest(store,{...original(),sourceKind:'rss',sourceId:'openai'});let calls=0;
    const run=await new Runner(store,new Collector(store,{request:async()=>{calls++;throw new Error('unexpected network');}},'',false),{analyze:async evidence=>({signals:[],excludedEvidenceIds:evidence.map(item=>item.id)})}).scan('重新核实');
    assert.equal(run?.analyzed,1);assert.equal(calls,0);
  }finally{store.close();}
});
test('后续补齐回复类型和原文链接，未知历史候选可恢复审核资格',()=>{
  const store=new Store(':memory:');try{
    const unknown=applyQuality(post({postType:undefined}));ingest(store,unknown);const old=store.get<Candidate>('candidates',unknown.id)!;store.put('candidates',old.id,{...old,processedHash:old.contentHash,attempts:3});
    const recovered=applyQuality(post({outboundUrls:['https://openai.com/news/release']}));ingest(store,recovered);const value=store.get<Candidate>('candidates',unknown.id)!;assert.equal(value.postType,'original');assert.equal(value.processedHash,null);assert.equal(value.attempts,0);assert.equal(value.quality?.decision,'eligible');
  }finally{store.close();}
});
test('站点限定结果必须属于目标平台，搜索跳转仅在解析后继续判断',()=>{
  assert.equal(assess({...original(),searchSites:['bilibili.com/video']}).decision,'filtered');
  const item={...original(),url:'https://www.sogou.com/link?url=token',finalUrl:'https://www.sogou.com/link?url=token',searchSites:['bilibili.com/video']};assert.equal(assess(item).decision,'eligible');
  assert.equal(assess({...item,finalUrl:'https://www.bilibili.com/video/BV123/'}).decision,'eligible');
  assert.equal(assess({...item,finalUrl:'https://www.bilibili.com/' }).decision,'filtered');
});
test('公开搜索独立发现后读取原文，旧文即使摘要像新消息也不发起分析',async()=>{
  const store=new Store(':memory:');try{
    for(const source of store.list<Source>('sources'))store.remove('sources',source.id);store.put('sources',web.id,web);store.put('rules',rule.id,rule);let calls=0;
    const collector=new Collector(store,{request:async url=>({status:200,url,headers:{},text:url.includes('/search')?'<li class="b_algo"><h2><a href="https://example.com/news/old">Old release</a></h2><div class="b_caption"><p>Recent-looking snippet</p></div></li>':'<meta property="article:published_time" content="2020-01-01T00:00:00Z"><article>'+('Old article '.repeat(20))+'</article>'})},'',false);
    const run=await new Runner(store,collector,{analyze:async()=>{calls++;return{signals:[],excludedEvidenceIds:[]}}}).scan('测试');assert.equal(calls,0);assert.equal(run?.sources[0].status,'success');assert.equal(store.list<Candidate>('candidates').length,1);assert.equal(store.list<Candidate>('candidates')[0].quality?.decision,'filtered');
  }finally{store.close();}
});
