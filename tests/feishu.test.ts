import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { config, safeError } from '../server/config.js';
import { Store } from '../server/db.js';
import { createApp, dashboard } from '../server/app.js';
import { activateFeishu, feishuConfigured, feishuContent, FeishuNotifier, feishuSignature, queueFeishuNotifications, validFeishuWebhook } from '../server/feishu.js';
import { eligible, Mailer, queueNotifications } from '../server/mail.js';
import { hash, makeEvidence } from '../server/parse.js';
import { analysisSchema, validateAnalysis } from '../server/ai.js';
import type { HttpClient, HttpDocument, RequestOptions } from '../server/http.js';
import type { FeishuJob, MailJob, Rule, Signal, Source } from '../shared/types.js';
import { fixtureAssessment } from './analysis-fixture.js';

const original = { webhook: config.feishuWebhook, secret: config.feishuSecret };
beforeEach(() => { config.feishuWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-webhook'; config.feishuSecret = 'test-only-signing-secret'; });
afterEach(() => { config.feishuWebhook = original.webhook; config.feishuSecret = original.secret; });
const now = Date.now(); const iso = (value: number) => new Date(value).toISOString();
const rule: Rule = { id: 'test-rule', name: 'Test release', query: 'test release', kind: 'keyword', enabled: true, notify: true, createdAt: iso(now - 7200000), baselineAt: iso(now - 3600000), lastRunAt: null, nextRunAt: iso(now) };
const source: Source = { id: 'test', name: 'Test', kind: 'rss', url: 'https://openai.com/news/rss.xml', enabled: true, official: true };
function signal(): Signal {
  const ev = makeEvidence(source, { title: 'Test release', url: 'https://openai.com/news/test-release', text: 'The project released version 1 with new code completion features. '.repeat(5), publishedAt: iso(now - 30000), original: true, official: true });
  const data = analysisSchema.parse({ events: [{ title: 'Test release', summary: '测试摘要', entity: 'test-model', version: '1', eventType: 'release', occurredAt: iso(now - 30000), isNewsworthy: true, isNewEvent: true, status: 'confirmed', reason: '原始发布材料', attention: 80, attentionReason: 'Test', importance: 'medium', importanceReason: 'Test', tags: [], evidenceIds: [ev.id], ruleIds: [rule.id], ruleAssessments: [fixtureAssessment(ev, rule)], existingEventId: null }], excludedEvidenceIds: [] });
  return { ...validateAnalysis(data, [ev], [rule], [])[0], firstSeenAt: iso(now - 10000) };
}
function prepare(filename = ':memory:') {
  const store = new Store(filename); const value = signal();
  store.put('state', 'settings', { ...store.settings(), recipient: 'test@example.com', feishuEnabled: true });
  activateFeishu(store, now - 60000); store.put('events', value.id, value); store.put('rules', rule.id, rule);
  return { store, value };
}
const response = (value: unknown, status = 200): HttpDocument => ({ status, headers: {}, url: config.feishuWebhook, text: typeof value === 'string' ? value : JSON.stringify(value) });
const success: HttpClient = { request: async () => response({ code: 0, msg: 'success' }) };

test('飞书仅接受官方 HTTPS Webhook，签名符合官方 HMAC 算法固定向量', () => {
  assert.equal(feishuConfigured(), true);
  for (const url of ['', 'http://open.feishu.cn/open-apis/bot/v2/hook/key', 'https://open.feishu.cn.evil.com/open-apis/bot/v2/hook/key', 'https://127.0.0.1/open-apis/bot/v2/hook/key', 'https://user@open.feishu.cn/open-apis/bot/v2/hook/key', `${config.feishuWebhook}?token=foo`, 'https://open.feishu.cn/not-a-hook']) assert.equal(validFeishuWebhook(url), false);
  assert.equal(feishuSignature('1599360473', 'demo'), 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
});

test('飞书发送包含秒级时间戳与签名，禁止转发到重定向；无签名配置也可发送', async () => {
  const { store } = prepare(); const requests: RequestOptions[] = [];
  const notifier = new FeishuNotifier(store, { request: async (url, options) => { assert.equal(url, config.feishuWebhook); requests.push(options!); return response({ code: 0 }); } });
  try {
    await notifier.send({ msg_type: 'text', content: { text: 'Test' } }, 1599360473000);
    const first = JSON.parse(requests[0].body!);
    assert.equal(first.timestamp, '1599360473'); assert.equal(first.sign, feishuSignature(first.timestamp, config.feishuSecret));
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].allowRedirects, false); assert.equal(requests[0].timeoutMs, 15000);
    config.feishuSecret = ''; await notifier.test(); assert.equal(JSON.parse(requests[1].body!).sign, undefined);
  } finally { store.close(); }
});

test('HTTP 200 业务错误、非法 JSON、缺少成功码及 HTTP 错误均不能误报成功', async () => {
  const { store } = prepare();
  try {
    for (const result of [response({ code: 19021, msg: 'signature mismatch' }), response('not JSON'), response({ msg: 'success' }), response(null), response({ code: 0 }, 429)]) {
      await assert.rejects(new FeishuNotifier(store, { request: async () => result }).test());
    }
    await new FeishuNotifier(store, { request: async () => response({ StatusCode: 0, StatusMessage: 'success' }) }).test();
  } finally { store.close(); }
});

test('飞书消息有摘要、监控、核实依据和原始链接；控制多字节长度且不生成群 @', () => {
  const { store, value } = prepare();
  try {
    value.title = '新事件'.repeat(5000); value.reason = '依据'.repeat(10000);
    value.ruleAssessments![0].summary = '<at user_id="all">所有人</at>' + '摘要'.repeat(10000);
    value.evidence = Array.from({ length: 20 }, (_, i) => ({ ...value.evidence[0], id: `source-${i}`, title: '原文'.repeat(500), finalUrl: `https://example.com/${i}` }));
    const payload = feishuContent(value, rule); const json = JSON.stringify(payload);
    assert.ok(Buffer.byteLength(json) < 20 * 1024); assert.match(json, /核实依据/); assert.match(json, /命中监控/); assert.match(json, /北京时间/);
    const content = (payload.content as { post: { zh_cn: { content: {tag:string; href?:string}[][] } } }).post.zh_cn.content.flat();
    assert.equal(content.filter(item => item.tag === 'a').length, 3); assert.ok(content.every(item => ['a', 'text'].includes(item.tag)));
  } finally { store.close(); }
});

test('新渠道启用前历史不补发；基线、暂停、待核实和非关键词事件不发；独立去重', () => {
  const { store, value } = prepare();
  try {
    assert.equal(eligible(value, rule, now), true);
    assert.equal(queueFeishuNotifications(store, [{ ...value, firstSeenAt: iso(now - 120000) }], [rule], now), 0);
    for (const r of [{ ...rule, baselineAt: null }, { ...rule, enabled: false }, { ...rule, notify: false }, { ...rule, kind: 'topic' as const }]) assert.equal(queueFeishuNotifications(store, [value], [r], now), 0);
    assert.equal(queueFeishuNotifications(store, [{ ...value, status: 'pending' }], [rule], now), 0);
    assert.equal(queueNotifications(store, [value], [rule], now), 1);
    assert.equal(queueFeishuNotifications(store, [value], [rule], now), 1);
    assert.equal(queueNotifications(store, [value], [rule], now), 0); assert.equal(queueFeishuNotifications(store, [value], [rule], now), 0);
    assert.notEqual(store.list<FeishuJob>('feishu')[0].id, store.list<MailJob>('mail')[0].id);
  } finally { store.close(); }
});

test('邮箱失败不阻塞飞书成功；飞书重试不会重发已提交的邮件', async () => {
  for (const mailFails of [true, false]) {
    const { store, value } = prepare(); let mails = 0; let pushes = 0;
    try {
      queueNotifications(store, [value], [rule], now); queueFeishuNotifications(store, [value], [rule], now);
      const mailer = new Mailer(store, { verify: async () => {}, sendMail: async () => { mails++; if (mailFails) throw Error('mail offline'); return { accepted: ['test@example.com'] }; } });
      const notifier = new FeishuNotifier(store, { request: async () => { pushes++; if (!mailFails && pushes === 1) throw Error('feishu offline'); return response({ code: 0 }); } });
      await Promise.all([mailer.flush(now, true), notifier.flush(now)]);
      assert.equal(store.list<MailJob>('mail')[0].status, mailFails ? 'retry' : 'submitted');
      assert.equal(store.list<FeishuJob>('feishu')[0].status, mailFails ? 'submitted' : 'retry');
      if (!mailFails) { const retry = store.list<FeishuJob>('feishu')[0]; await Promise.all([mailer.flush(Date.parse(retry.nextAttemptAt), true), notifier.flush(Date.parse(retry.nextAttemptAt))]); assert.equal(mails, 1); assert.equal(pushes, 2); }
      else { await notifier.flush(now + 1000); assert.equal(pushes, 1); }
    } finally { store.close(); }
  }
});

test('飞书限流或超时退避重试，最多四次；凭据不进入错误和仪表盘', async () => {
  const { store, value } = prepare(); let calls = 0;
  try {
    queueFeishuNotifications(store, [value], [rule], now);
    const notifier = new FeishuNotifier(store, { request: async () => { calls++; throw Error(`timeout ${config.feishuWebhook} ${config.feishuSecret}`); } });
    let time = now;
    for (let i = 1; i <= 4; i++) {
      await notifier.flush(time); const job = store.list<FeishuJob>('feishu')[0];
      assert.equal(job.attempts, i); assert.equal(job.status, i < 4 ? 'retry' : 'failed');
      assert.ok(!job.error!.includes(config.feishuWebhook)); assert.ok(!job.error!.includes(config.feishuSecret));
      await notifier.flush(time + 1); assert.equal(calls, i); time = Date.parse(job.nextAttemptAt);
    }
    const state = JSON.stringify(dashboard(store)); assert.ok(!state.includes(config.feishuWebhook)); assert.ok(!state.includes(config.feishuSecret));
    assert.ok(!safeError(Error(config.feishuWebhook.split('/').at(-1)!)).includes('test-only-webhook'));
  } finally { store.close(); }
});

test('关闭飞书不影响邮箱；重新启用和更换群后取消旧任务，不补发已有事件', async () => {
  for (const changeGroup of [true, false]) {
    const { store, value } = prepare(); let calls = 0;
    try {
      queueFeishuNotifications(store, [value], [rule], now);
      store.put('state', 'settings', { ...store.settings(), feishuEnabled: false });
      const notifier = new FeishuNotifier(store, { request: async () => { calls++; return response({ code: 0 }); } });
      await notifier.flush(now + 1000); assert.equal(calls, 0); assert.equal(queueNotifications(store, [value], [rule], now), 1);
      store.put('state', 'settings', { ...store.settings(), feishuEnabled: true });
      if (changeGroup) { config.feishuWebhook += '-changed'; queueFeishuNotifications(store, [], [], now + 2000); }
      else activateFeishu(store, now + 2000);
      await notifier.flush(now + 3000); assert.equal(calls, 0); assert.equal(store.list<FeishuJob>('feishu')[0].status, 'failed');
      assert.equal(queueFeishuNotifications(store, [value], [rule], now + 3000), 0);
    } finally { store.close(); }
  }
});

test('飞书队列和启用时间在重启后保留；旧设置默认关闭飞书', async () => {
  const prefix = path.join(tmpdir(), 'firstcue-feishu-'); const dir = mkdtempSync(prefix); const filename = path.join(dir, 'test.sqlite');
  try {
    const { store, value } = prepare(filename); queueFeishuNotifications(store, [value], [rule], now); store.close();
    const reopened = new Store(filename);
    try { await new FeishuNotifier(reopened, success).flush(now); assert.equal(reopened.list<FeishuJob>('feishu')[0].status, 'submitted'); }
    finally { reopened.close(); }
    const legacy = new Store(':memory:');
    try { const { feishuEnabled: _, ...settings } = legacy.settings(); legacy.put('state', 'settings', settings); assert.equal(legacy.settings().feishuEnabled, false); }
    finally { legacy.close(); }
  } finally { if (path.resolve(dir).startsWith(path.resolve(prefix))) rmSync(dir, { recursive: true, force: true }); }
});

test('飞书 API 支持启用、测试及单渠道重试，拒绝未配置启用与重复提交', async () => {
  const { store, value } = prepare(); let calls = 0;
  const app = createApp(store, { request: async () => { calls++; return response({ code: 0 }); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (url: string, method = 'POST', body?: unknown) => fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    queueNotifications(store, [value], [rule], now); queueFeishuNotifications(store, [value], [rule], now);
    assert.equal((await request('/services/feishu-test')).status, 200); assert.equal(calls, 1);
    const job = store.list<FeishuJob>('feishu')[0]; const route = `/feishu/${job.id}/retry`;
    assert.equal((await request(route)).status, 409);
    store.put('feishu', job.id, { ...job, status: 'failed' }); assert.equal((await request(route)).status, 200);
    assert.equal(store.list<MailJob>('mail')[0].attempts, 0);
    store.put('feishu', job.id, { ...job, status: 'submitted' }); assert.equal((await request(route)).status, 409);
    const data = await (await request('/dashboard', 'GET')).json() as DashboardWithChannels;
    assert.deepEqual(new Set(data.notifications.map(item => item.channel)), new Set(['mail', 'feishu']));
    assert.equal((await request('/settings', 'PATCH', { feishuEnabled: false })).status, 200);
    assert.equal((await request('/settings', 'PATCH', { feishuEnabled: true })).status, 200);
    assert.equal(store.get<{targetId:string}>('state', 'feishuSubscription')!.targetId, hash(config.feishuWebhook));
    config.feishuWebhook = ''; assert.equal((await request('/settings', 'PATCH', { feishuEnabled: true })).status, 400);
    assert.equal((await request('/services/feishu-test')).status, 500); assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
type DashboardWithChannels = { notifications: { channel: string }[] };
