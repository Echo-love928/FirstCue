import { randomUUID } from 'node:crypto';
import type { Rule } from '../shared/types.js';
import { Store } from './db.js';
import { PublicHttp } from './http.js';
import { Collector } from './sources.js';
import { Analyzer } from './ai.js';
import { Runner } from './runner.js';
import { Mailer } from './mail.js';
import { FeishuNotifier, queueFeishuNotifications } from './feishu.js';
import { safeError } from './config.js';
import { queueDigestNotifications } from './digest.js';
import { expireContent } from './retention.js';
const store = new Store(); const http = new PublicHttp(); const owner = randomUUID();
const runner = new Runner(store, new Collector(store, http), new Analyzer(store, http)); const mailer = new Mailer(store);
const feishu = new FeishuNotifier(store, http);
let busy = false; let notifying=false; let lastExpiry = 0;
function heartbeat(): boolean { if (!store.lease('worker', owner, 45000)) return false; store.put('state', 'workerHeartbeat', new Date().toISOString()); return true; }
async function tick() {
  if (busy || !heartbeat()) return;
  busy = true;
  try {
    if(Date.now()-lastExpiry >= 60000) {expireContent(store);lastExpiry=Date.now();}
    const request = store.get<{ trigger: string }>('state', 'scanRequest');
    if (request) { store.remove('state', 'scanRequest'); await runner.scan(request.trigger); }
    else if (store.list<Rule>('rules').some(rule => rule.enabled && Date.parse(rule.nextRunAt) <= Date.now())) await runner.scan();
  } catch (error) { console.error(`后台任务：${safeError(error)}`); }
  finally { busy = false; }
}
async function notificationTick(){
  if(notifying||!heartbeat())return;
  notifying=true;
  try{
    queueFeishuNotifications(store,[],[]);
    queueDigestNotifications(store);
    const results = await Promise.allSettled([mailer.flush(), feishu.flush()]);
    for (const [index, result] of results.entries()) if (result.status === 'rejected') console.error(`${index === 0 ? '邮箱' : '飞书'}通知：${safeError(result.reason)}`);
  }catch(error){console.error(`汇总通知：${safeError(error)}`);}
  finally{notifying=false;}
}
const timer = setInterval(() => void tick(), 2000);const notifications=setInterval(()=>void notificationTick(),2000); const beat = setInterval(heartbeat, 10000);
void tick();void notificationTick(); console.log('FirstCue worker: 30 分钟监控及热点汇总，持久化任务已恢复');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(timer); clearInterval(notifications);clearInterval(beat); store.release('worker', owner); process.exit(0); });
