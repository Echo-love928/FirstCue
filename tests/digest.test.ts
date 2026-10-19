import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {Store} from '../server/db.js';
import {config,INTERVAL_MS} from '../server/config.js';
import {makeEvidence} from '../server/parse.js';
import {activateFeishu,queueFeishuNotifications,FeishuNotifier} from '../server/feishu.js';
import {Mailer} from '../server/mail.js';
import {digestSelection,queueDigestNotifications,flushDigestJobs,mailDigestContent,feishuDigestContent} from '../server/digest.js';
import {createApp,dashboard} from '../server/app.js';
import type {Candidate,MailJob,FeishuJob,Rule,Source} from '../shared/types.js';

const original={webhook:config.feishuWebhook,secret:config.feishuSecret};
beforeEach(()=>{config.feishuWebhook='https://open.feishu.cn/open-apis/bot/v2/hook/digest-test';config.feishuSecret='test-only';});
afterEach(()=>{config.feishuWebhook=original.webhook;config.feishuSecret=original.secret;});
const now=Date.now(),iso=(n:number)=>new Date(n).toISOString();
const rule:Rule={id:'rule',name:'OpenAI',query:'OpenAI相关内容',kind:'keyword',enabled:true,notify:true,baselineAt:null,createdAt:iso(now-86400000),nextRunAt:iso(now),lastRunAt:null};
const source:Source={id:'test',name:'Test',kind:'web',url:'https://example.com/',official:false,enabled:true};
function raw(n:number,at=now-60000):Candidate{return {...makeEvidence(source,{url:`https://example.com/openai/${n}`,title:`OpenAI release ${n}`,text:'OpenAI released a coding model with examples for repository and code completion tasks.',publishedAt:iso(at),original:true,contentKind:'article',likes:n}),firstDiscoveredAt:iso(at),fetchedAt:iso(at),attempts:0,processedHash:null};}
function prepare(count=3,file=':memory:'){
  const store=new Store(file);store.put('rules',rule.id,rule);store.put('rules','duplicate',{...rule,id:'duplicate'});
  store.put('state','settings',{...store.settings(),recipient:'test@example.com',feishuEnabled:true});activateFeishu(store,now-30000);
  for(let n=1;n<=count;n++){const item=raw(n);store.put('candidates',item.id,item);}return store;
}
const jobs=(store:Store,channel='mail')=>store.list<MailJob>(channel);

test('当前未核实精选首次整体进入两路通知，不依赖基线、不按监控重复发送；只取热度最高100条',()=>{
  const store=prepare(120);try{
    assert.equal(digestSelection(store,now).length,100);assert.equal(digestSelection(store,now)[0].evidence[0].likes,120);
    assert.equal(queueDigestNotifications(store,now),2);
    for(const channel of ['mail','feishu']){assert.equal(jobs(store,channel).length,1);const digest=jobs(store,channel)[0].digest!;assert.equal(digest.signals.length,100);assert.equal(digest.signals[0].status,'pending');assert.equal(digest.keys.length,100);assert.equal(digest.initial,true);}
    assert.equal(queueDigestNotifications(store,now+1000),0);assert.equal(queueDigestNotifications(store,now+INTERVAL_MS-1),0);
    assert.equal(queueDigestNotifications(store,now+INTERVAL_MS),0);assert.equal(jobs(store).length,1);
    const item=raw(121,now+INTERVAL_MS+1000);store.put('candidates',item.id,item);
    assert.equal(queueDigestNotifications(store,now+INTERVAL_MS*2),2);
    assert.equal(jobs(store).length,2);assert.equal(jobs(store).find(job=>!job.digest!.initial)!.digest!.signals.length,1);
  }finally{store.close();}
});

test('同一原文后来变为分析事件仍然去重，关闭通知的监控不会推送',()=>{
  const store=prepare();try{
    queueDigestNotifications(store,now);const value=digestSelection(store,now)[0];store.put('events','analyzed',{...value,id:'analyzed',discoveryOnly:false});
    assert.equal(queueDigestNotifications(store,now+INTERVAL_MS),0);
    for(const r of store.list<Rule>('rules'))store.put('rules',r.id,{...r,notify:false});
    const item=raw(9,now+INTERVAL_MS+1000);store.put('candidates',item.id,item);
    assert.equal(queueDigestNotifications(store,now+INTERVAL_MS*2),0);
  }finally{store.close();}
});

test('邮箱失败不影响飞书；重试间隔30分钟、邮件ID稳定、不会重发成功渠道',async()=>{
  const store=prepare();let emails=0,pushes=0;const ids:unknown[]=[];try{
    queueDigestNotifications(store,now);
    const mailer=new Mailer(store,{verify:async()=>{},sendMail:async message=>{emails++;ids.push(message.messageId);assert.match(String(message.text),/OpenAI release 1/);if(emails===1)throw Error('offline');return{accepted:['test@example.com']};}});
    const feishu=new FeishuNotifier(store,{request:async()=>{pushes++;return{status:200,url:config.feishuWebhook,headers:{},text:'{"code":0}'};}});
    await Promise.all([mailer.flush(now,true),feishu.flush(now)]);assert.equal(jobs(store)[0].status,'retry');assert.equal(jobs(store,'feishu')[0].status,'submitted');
    await Promise.all([mailer.flush(now+INTERVAL_MS-1,true),feishu.flush(now+INTERVAL_MS-1)]);assert.equal(emails,1);assert.equal(pushes,1);
    await Promise.all([mailer.flush(now+INTERVAL_MS,true),feishu.flush(now+INTERVAL_MS)]);assert.equal(emails,2);assert.equal(pushes,1);assert.equal(ids[0],ids[1]);assert.equal(jobs(store)[0].status,'submitted');
  }finally{store.close();}
});

test('持续失败最多尝试4次，手工提前标记重试也不能绕过发送间隔',async()=>{
  const store=prepare();let calls=0;try{
    queueDigestNotifications(store,now);const fail=async()=>{calls++;throw Error('offline');};
    for(let n=0;n<4;n++){
      await flushDigestJobs(store,'mail',fail,now+n*INTERVAL_MS);const job=jobs(store)[0];assert.equal(job.attempts,n+1);assert.equal(job.status,n===3?'failed':'retry');
      store.put('mail',job.id,{...job,nextAttemptAt:iso(now)});await flushDigestJobs(store,'mail',fail,now+n*INTERVAL_MS+1);assert.equal(calls,n+1);
    }
  }finally{store.close();}
});

test('更换接收邮箱或飞书群、重新启用渠道均不向新目标转发旧汇总',async()=>{
  for(const change of ['mail','feishu','reactivate'] as const){const store=prepare();let sent=0;try{
    queueDigestNotifications(store,now);
    if(change==='mail')store.put('state','settings',{...store.settings(),recipient:'new@example.com'});
    else if(change==='feishu'){config.feishuWebhook+='-new';queueFeishuNotifications(store,[],[],now+1000);}
    else activateFeishu(store,now+1000);
    queueDigestNotifications(store,now+1000);
    await flushDigestJobs(store,change==='mail'?'mail':'feishu',async()=>{sent++;},now+2000);assert.equal(sent,0);
    queueDigestNotifications(store,now+INTERVAL_MS);assert.equal(jobs(store,change==='mail'?'mail':'feishu').length,1);
    const item=raw(8,now+INTERVAL_MS+1000);store.put('candidates',item.id,item);queueDigestNotifications(store,now+INTERVAL_MS*2);
    await flushDigestJobs(store,change==='mail'?'mail':'feishu',async()=>{sent++;},now+INTERVAL_MS*2);assert.equal(sent,1);
  }finally{store.close();}}
});

test('发送前重新检查暂停和时效，旧逐条任务退役；并发发送由租约去重',async()=>{
  const store=prepare();try{
    const value=digestSelection(store,now)[0];store.put('mail','legacy',{id:'legacy',status:'pending',signal:value});queueDigestNotifications(store,now);assert.equal(jobs(store).find(job=>job.id==='legacy')!.status,'failed');
    let calls=0;await Promise.all([flushDigestJobs(store,'mail',async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,25));},now),flushDigestJobs(store,'mail',async()=>{calls++;},now)]);assert.equal(calls,1);
    for(const r of store.list<Rule>('rules'))store.put('rules',r.id,{...r,enabled:false});await flushDigestJobs(store,'feishu',async()=>{calls++;},now);assert.equal(calls,1);assert.equal(jobs(store,'feishu')[0].status,'failed');
  }finally{store.close();}
  const expired=prepare();try{queueDigestNotifications(expired,now);await flushDigestJobs(expired,'mail',async()=>assert.fail('expired sent'),now+6*86400000);assert.equal(jobs(expired)[0].status,'failed');}finally{expired.close();}
});

test('重启保留汇总和冷却时间；仪表盘只传计数，通知详情返回完整快照',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'firstcue-digest-'));const file=path.join(dir,'test.sqlite');
  try{
    const store=prepare(3,file);queueDigestNotifications(store,now);await flushDigestJobs(store,'mail',async()=>{},now);store.close();
    const reopened=new Store(file);const server=createApp(reopened,{request:async()=>{throw Error('Unexpected external request');}}).listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    try{
      assert.equal(queueDigestNotifications(reopened,now+10000),0);
      const data=dashboard(reopened),job=data.notifications.find(job=>job.channel==='mail')!;assert.equal(job.digest!.count,3);assert.equal(job.digest!.signals.length,0);
      const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;const detail=await(await fetch(`${base}/api/notifications/mail/${job.id}`)).json() as MailJob;assert.equal(detail.digest!.signals.length,3);
      assert.equal((await fetch(`${base}/api/notifications/other/${job.id}`)).status,400);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));reopened.close();}
  }finally{if(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep))rmSync(dir,{recursive:true,force:true});}
});

test('100条长中文内容邮件完整转义，飞书按字节控制并明确提示完整汇总入口',()=>{
  const store=prepare(100);try{
    queueDigestNotifications(store,now);const digest=jobs(store)[0].digest!;for(const signal of digest.signals){signal.title='<at user_id="all">热点</at>'+ '新消息'.repeat(500);signal.summary='<script>bad</script>';signal.evidence[0].finalUrl+='/'+'long'.repeat(300);}
    const email=mailDigestContent(digest);assert.match(email.text,/100\./);assert.ok(!email.html.includes('<script>'));assert.ok(email.html.includes('&lt;script&gt;'));
    const feishu=feishuDigestContent(digest);assert.ok(Buffer.byteLength(JSON.stringify(feishu.message))<20*1024);assert.ok(feishu.renderedCount<100);assert.match(JSON.stringify(feishu.message),/完整 100 条/);
    const nodes=(feishu.message.content as {post:{zh_cn:{content:{tag:string}[][]}}}).post.zh_cn.content.flat();assert.ok(nodes.every(node=>['text','a'].includes(node.tag)));
  }finally{store.close();}
});
