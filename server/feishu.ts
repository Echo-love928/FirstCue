import { createHmac } from 'node:crypto';
import type { FeishuJob, Rule, Signal } from '../shared/types.js';
import { config, safeError } from './config.js';
import { Store } from './db.js';
import type { HttpClient } from './http.js';
import { hash } from './parse.js';
import { eligible } from './mail.js';
import { directAssessments } from '../shared/relevance.js';

export function validFeishuWebhook(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'open.feishu.cn' && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(url.pathname);
  } catch { return false; }
}
export function feishuConfigured(): boolean { return validFeishuWebhook(config.feishuWebhook); }
export function feishuSignature(timestamp: string, secret: string): string {
  // Feishu signs an empty message with timestamp + newline + secret as the HMAC key.
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}
interface Subscription { targetId: string; activatedAt: string; }
export function activateFeishu(store: Store, now = Date.now()): void {
  store.put('state', 'feishuSubscription', { targetId: hash(config.feishuWebhook), activatedAt: new Date(now).toISOString() } satisfies Subscription);
}
export function queueFeishuNotifications(store: Store, signals: Signal[], rules: Rule[], now = Date.now()): number {
  if (!store.settings().feishuEnabled || !feishuConfigured()) return 0;
  const targetId = hash(config.feishuWebhook);
  let count = 0;
  store.transaction(() => {
    const subscription = store.get<Subscription>('state', 'feishuSubscription');
    // A changed group must not receive the old group's queue or historical events.
    if (!subscription || subscription.targetId !== targetId) { activateFeishu(store, now); return; }
    for (const signal of signals) for (const rule of rules) {
      if (!eligible(signal, rule, now) || !(Date.parse(signal.firstSeenAt) > Date.parse(subscription.activatedAt))) continue;
      const id = hash(`feishu:${targetId}:${rule.id}:${signal.id}`);
      if (store.get('feishu', id)) continue;
      const job: FeishuJob = { id, channel: 'feishu', targetId, eventId: signal.id, ruleId: rule.id, title: signal.title, recipient: '飞书群机器人', status: 'pending', attempts: 0, nextAttemptAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), submittedAt: null, error: null, signal };
      store.put('feishu', id, job); count++;
    }
  });
  return count;
}

// Rich text treats collected text as text, avoiding accidental @all or markdown injection.
export function feishuContent(signal: Signal, rule: Rule): Record<string, unknown> {
  const assessment = directAssessments(signal, rule.id)[0];
  const clean = (value: string, max: number) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
  const text = (value: string) => [{ tag: 'text', text: value }];
  const content: Record<string, string>[][] = [
    text(clean(assessment?.summary || signal.summary, 1200)),
    text(`命中监控：${clean(rule.name, 100)}`),
    text(`匹配原因：${clean(assessment?.reason || '', 500)}`),
    text(`核实依据：${clean(signal.reason, 500)}`),
    text(`发现时间：${new Date(signal.firstSeenAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`),
  ];
  const seen = new Set<string>();
  for (const evidence of signal.evidence.filter(item => item.original)) {
    if (seen.size >= 3 || seen.has(evidence.finalUrl) || evidence.finalUrl.length > 1500) continue;
    try { const url = new URL(evidence.finalUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue; } catch { continue; }
    seen.add(evidence.finalUrl);
    content.push([{ tag: 'a', text: clean(evidence.title || '查看原始来源', 120), href: evidence.finalUrl }]);
  }
  return { msg_type: 'post', content: { post: { zh_cn: { title: `[FirstCue] ${clean(signal.title, 120)}`, content } } } };
}

export class FeishuNotifier {
  constructor(public store: Store, private http: HttpClient) {}
  async send(message: Record<string, unknown>, now = Date.now()): Promise<void> {
    if (!feishuConfigured()) throw new Error('飞书未配置或 Webhook 地址无效，请填写 .env 中的 FEISHU_WEBHOOK_URL 后重启');
    const timestamp = String(Math.floor(now / 1000));
    const payload = { ...message, ...(config.feishuSecret ? { timestamp, sign: feishuSignature(timestamp, config.feishuSecret) } : {}) };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 20 * 1024) throw new Error('飞书消息超过 20 KB 上限');
    const response = await this.http.request(config.feishuWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 15000, maxBytes: 64 * 1024, allowRedirects: false });
    if (response.status < 200 || response.status >= 300) throw new Error(`飞书请求失败（HTTP ${response.status}），请检查网络、限流或机器人配置`);
    let result: { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string };
    try { result = JSON.parse(response.text); } catch { throw new Error('飞书响应格式无效，未确认接受消息'); }
    if (!result || (result.code ?? result.StatusCode) !== 0) {
      const code = result?.code ?? result?.StatusCode;
      throw new Error(`飞书未接受消息（${code ?? '未知错误'}）：${safeError(result?.msg || result?.StatusMessage || '请检查签名、关键词或机器人权限')}`);
    }
  }
  async test(): Promise<void> {
    await this.send({ msg_type: 'text', content: { text: '[FirstCue] 飞书通知测试：收到这条消息后，请确认群机器人通知正常。邮箱通知继续独立发送。' } });
  }
  async flush(now = Date.now()): Promise<void> {
    if (!this.store.settings().feishuEnabled || !feishuConfigured()) return;
    const targetId = hash(config.feishuWebhook);
    const subscription = this.store.get<Subscription>('state', 'feishuSubscription');
    // One message per worker tick avoids bursts against Feishu's per-second limit.
    const jobs = this.store.list<FeishuJob>('feishu').filter(job => ['pending', 'retry'].includes(job.status) && Date.parse(job.nextAttemptAt) <= now).sort((a,b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 1);
    for (const job of jobs) {
      const rule = this.store.get<Rule>('rules', job.ruleId); const signal = this.store.get<Signal>('events', job.eventId);
      if (!rule || !signal || !eligible(signal, rule, now) || job.targetId !== targetId || !subscription || Date.parse(job.createdAt) < Date.parse(subscription.activatedAt)) {
        this.store.put('feishu', job.id, { ...job, status: 'failed', error: '监控或事件已失效、通知已重新启用或飞书群已变更，取消发送' }); continue;
      }
      const updated = { ...job, attempts: job.attempts + 1, signal };
      try {
        await this.send(feishuContent(signal, rule), now);
        this.store.put('feishu', job.id, { ...updated, status: 'submitted', submittedAt: new Date(now).toISOString(), error: null });
      } catch (error) {
        this.store.put('feishu', job.id, { ...updated, status: updated.attempts >= 4 ? 'failed' : 'retry', nextAttemptAt: new Date(now + 60000 * 2 ** updated.attempts).toISOString(), error: safeError(error) });
      }
    }
  }
}
