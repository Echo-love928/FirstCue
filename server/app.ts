import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { Account, Candidate, Dashboard, FeishuJob, MailJob, Rule, Run, Settings, Signal, Source } from '../shared/types.js';
import { Store } from './db.js';
import { config, safeError } from './config.js';
import { publicUrl, type HttpClient } from './http.js';
import { Analyzer } from './ai.js';
import { Mailer, mailConfigured } from './mail.js';
import { activateFeishu, feishuConfigured, FeishuNotifier } from './feishu.js';
import { hash } from './parse.js';
import { currentSignal, historicalSignal, expiredEvidence, FRESHNESS_HOURS, signalTime } from '../shared/freshness.js';
import { discoveryCandidate } from './quality.js';
import { analysisFingerprint, matchesRule, needsAnalysis } from '../shared/relevance.js';
import { normalizeMetadata } from '../shared/engagement.js';
const ruleInput = z.object({ name: z.string().trim().min(1).max(100), query: z.string().trim().min(1).max(300), kind: z.enum(['keyword', 'topic']), enabled: z.boolean(), notify: z.boolean() });
const settingsInput = z.object({ model: z.string().trim().max(150), recipient: z.union([z.literal(''), z.email()]), feishuEnabled: z.boolean(), aiDailyLimit: z.number().int().min(1).max(10000), xDailyLimit: z.number().int().min(1).max(100000), xResultDailyLimit: z.number().int().min(20).max(1000000), searchPerRunLimit: z.number().int().min(1).max(20), candidatePerRunLimit: z.number().int().min(1).max(60), lookbackHours: z.literal(FRESHNESS_HOURS) });
export function dashboard(store: Store, includeHistory = false): Dashboard {
  const heartbeat = store.get<string>('state', 'workerHeartbeat');
  const rules=store.list<Rule>('rules'); const enabled=rules.filter(rule=>rule.enabled);
  const events=store.list<Signal>('events').map(item=>item.relevanceVersion===undefined?item:{...item,ruleIds:item.ruleIds.filter(id=>{const rule=rules.find(rule=>rule.id===id);return !rule || matchesRule(item,rule);})});
  return { rules: store.list<Rule>('rules'), sources: store.list<Source>('sources'), accounts: store.list<Account>('accounts'), events: events.filter(item=>includeHistory ? historicalSignal(item) : currentSignal(item)).map(item=>({...item,evidence:item.evidence.map(normalizeMetadata)})).sort((a,b)=>(signalTime(b)||0)-(signalTime(a)||0)), runs: store.list<Run>('runs').slice(0, 30), notifications: [...store.list<MailJob>('mail').map(job => ({ ...job, channel: 'mail' as const })), ...store.list<FeishuJob>('feishu')].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100), settings: store.settings(), configured: { ai: !!config.aiKey, x: !!config.xKey, mail: mailConfigured(), feishu: feishuConfigured(), feishuSigning: !!config.feishuSecret, proxy: !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY) }, usage: store.usage(), worker: { alive: !!heartbeat && Date.now() - Date.parse(heartbeat) < 45000, heartbeat }, pendingAnalysis: store.list<Candidate>('candidates').filter(item => discoveryCandidate(item) && (needsAnalysis(item,enabled)) && (item.analysisFingerprint!==analysisFingerprint(enabled) || item.attempts < 3)).length, relevanceReview:[...store.list<Candidate>('candidates').filter(item=>item.relevanceExclusion?.category==='insufficient').map(item=>({id:item.id,title:item.title,reason:item.relevanceExclusion!.reason,url:item.finalUrl})),...store.list<Signal>('events').filter(item=>item.auditOnly&&item.auditReason?.startsWith('关联待审核')).map(item=>({id:item.id,title:item.title,reason:item.auditReason!,url:item.evidence[0]?.finalUrl||''}))].slice(0,50), intervalMinutes: 30, scanQueued: !!store.get('state', 'scanRequest') };
}
export function createApp(store: Store, http: HttpClient) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host?.split(':')[0];
    if (!host || !['127.0.0.1', 'localhost'].includes(host)) return res.status(403).json({ error: '仅支持本地访问' });
    const origin = req.headers.origin;
    if (origin) { let valid = false; try { const url = new URL(origin); valid = ['127.0.0.1', 'localhost'].includes(url.hostname) && ['3030', '5173', String(config.port)].includes(url.port); } catch { /* Invalid origin. */ } if (!valid) return res.status(403).json({ error: '请求来源不允许' }); }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/dashboard', (req, res) => { const query = z.object({ history: z.literal('all').optional() }).parse(req.query); res.json(dashboard(store, query.history === 'all')); });
  app.get('/api/audit', (_req, res) => res.json({
    candidates: store.list<Candidate>('candidates').filter(item=>item.relevanceExclusion || expiredEvidence(item) || item.quality?.decision === 'filtered' || item.quality?.decision === 'context').slice(0,200),
    events: store.list<Signal>('events').filter(item=>!currentSignal(item)).slice(0,100),
  }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));
  app.post('/api/rules', (req, res) => { const input = ruleInput.parse(req.body); const now = new Date().toISOString(); const rule: Rule = { ...input, notify: input.kind === 'keyword' && input.notify, id: randomUUID(), createdAt: now, baselineAt: null, nextRunAt: now, lastRunAt: null }; store.put('rules', rule.id, rule); res.status(201).json(rule); });
  app.patch('/api/rules/:id', (req, res) => { const rule = store.get<Rule>('rules', req.params.id); if (!rule) return res.status(404).json({ error: '监控不存在' }); const input = ruleInput.partial().parse(req.body); const updated = { ...rule, ...input }; updated.notify = updated.kind === 'keyword' && updated.notify; if (input.query && input.query !== rule.query || input.kind && input.kind !== rule.kind) { updated.baselineAt = null; updated.nextRunAt = new Date().toISOString(); } if (input.enabled && !rule.enabled) updated.nextRunAt = new Date().toISOString(); store.put('rules', rule.id, updated); res.json(updated); });
  app.delete('/api/rules/:id', (req, res) => { store.remove('rules', req.params.id); res.json({ ok: true }); });
  app.post('/api/scan', (_req, res) => { if (!store.list<Rule>('rules').some(rule => rule.enabled)) return res.status(400).json({ error: '请先添加并启用一条监控' });
    const accepted = store.transaction(() => { if (store.get('state', 'scanRequest')) return false; const last = store.get<number>('state', 'lastScanStarted'); if (last && Date.now() - last < 60000) return false; store.put('state', 'scanRequest', { trigger: '手动检查', at: Date.now() }); return true; });
    res.status(accepted ? 202 : 200).json({ queued: accepted, message: accepted ? '检查已加入后台队列' : '正在检查或处于冷却时间，已复用现有任务' });
  });
  app.post('/api/retry-analysis', (_req, res) => { if (!store.list<Rule>('rules').some(rule => rule.enabled)) return res.status(400).json({ error: '请先启用一条监控，再重新核实' }); for (const item of store.list<Candidate>('candidates').filter(value => discoveryCandidate(value) && !expiredEvidence(value) && needsAnalysis(value,store.list<Rule>('rules').filter(rule=>rule.enabled)))) store.put('candidates', item.id, { ...item, attempts: 0 }); store.put('state', 'scanRequest', { trigger: '重新核实', at: Date.now() }); res.json({ message: '待分析内容已加入重新核实队列，将复用已保存内容' }); });
  app.patch('/api/settings', (req, res) => {
    const input = settingsInput.partial().parse(req.body);
    if (input.feishuEnabled && !feishuConfigured()) return res.status(400).json({ error: '请先在 .env 配置有效的 FEISHU_WEBHOOK_URL 并重启，再启用飞书通知' });
    const updated = store.transaction(() => {
      const previous = store.settings(); const next: Settings = { ...previous, ...input };
      if (next.feishuEnabled && !previous.feishuEnabled) activateFeishu(store);
      store.put('state', 'settings', next); return next;
    });
    res.json(updated);
  });
  app.patch('/api/sources/:id', (req, res) => { const source = store.get<Source>('sources', req.params.id); if (!source) return res.status(404).json({ error: '来源不存在' }); const input = z.object({ enabled: z.boolean() }).parse(req.body); store.put('sources', source.id, { ...source, ...input }); res.json({ ok: true }); });
  app.post('/api/sources', (req, res) => { const input = z.object({ name: z.string().trim().min(1).max(80), url: z.string().url() }).parse(req.body); try { publicUrl(input.url); } catch (error) { return res.status(400).json({ error: safeError(error) }); } const source: Source = { ...input, id: randomUUID(), kind: 'rss', enabled: true, official: false }; store.put('sources', source.id, source); res.status(201).json(source); });
  app.delete('/api/sources/:id', (req, res) => { const source = store.get<Source>('sources', req.params.id); if (source?.kind !== 'rss' || ['openai', 'google', 'huggingface','anthropic','cursor','vscode','qwen','deepseek'].includes(source.id)) return res.status(400).json({ error: '内置来源请使用暂停功能' }); store.remove('sources', req.params.id); res.json({ ok: true }); });
  app.post('/api/accounts', (req, res) => { const input = z.object({ userName: z.string().trim().regex(/^@?[A-Za-z0-9_]{1,15}$/) }).parse(req.body); const userName = input.userName.replace(/^@/, ''); if (store.list<Account>('accounts').some(item => item.userName.toLowerCase() === userName.toLowerCase())) return res.status(409).json({ error: '该账号已添加' }); const account: Account = { id: randomUUID(), userName, userId: null, enabled: true }; store.put('accounts', account.id, account); res.status(201).json(account); });
  app.delete('/api/accounts/:id', (req, res) => { store.remove('accounts', req.params.id); res.json({ ok: true }); });
  app.post('/api/services/ai-check', async (_req, res) => res.json(await new Analyzer(store, http).modelCheck()));
  app.post('/api/services/mail-check', async (_req, res) => { await new Mailer(store).verify(); res.json({ message: 'SMTP 连接和认证成功；请发送测试邮件确认收件' }); });
  app.post('/api/services/mail-test', async (_req, res) => { await new Mailer(store).test(); res.json({ message: 'SMTP 已接受测试邮件，请检查收件箱' }); });
  app.post('/api/services/feishu-test', async (_req, res) => { await new FeishuNotifier(store, http).test(); res.json({ message: '飞书已接受测试消息，请到机器人所在群确认收件' }); });
  app.post('/api/feishu/:id/retry', (req, res) => {
    const job = store.get<FeishuJob>('feishu', req.params.id);
    if (!job) return res.status(404).json({ error: '通知不存在' });
    if (job.status === 'submitted') return res.status(409).json({ error: '飞书已接受的消息不重复发送' });
    if (job.status !== 'failed') return res.status(409).json({ error: '该消息正在排队或自动重试，请勿重复触发' });
    if (!store.settings().feishuEnabled || !feishuConfigured()) return res.status(400).json({ error: '请先配置并启用飞书通知' });
    const subscription = store.get<{targetId: string; activatedAt: string}>('state', 'feishuSubscription');
    if (!subscription || subscription.targetId !== job.targetId || subscription.targetId !== hash(config.feishuWebhook) || Date.parse(job.createdAt) < Date.parse(subscription.activatedAt)) return res.status(409).json({ error: '飞书群或启用时间已变更，旧任务不能重发到当前群' });
    store.put('feishu', job.id, { ...job, status: 'pending', attempts: 0, nextAttemptAt: new Date().toISOString(), error: null }); res.json({ ok: true });
  });
  app.post('/api/mail/:id/retry', (req, res) => { const job = store.get<MailJob>('mail', req.params.id); if (!job) return res.status(404).json({ error: '通知不存在' }); if (job.status === 'submitted') return res.status(409).json({ error: '已提交的邮件不重复发送' }); store.put('mail', job.id, { ...job, status: 'pending', attempts: 0, nextAttemptAt: new Date().toISOString(), error: null }); res.json({ ok: true }); });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  const dist = path.resolve('dist'); if (existsSync(path.join(dist, 'index.html'))) { app.use(express.static(dist, { index: false })); app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html'))); }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (error instanceof z.ZodError) return res.status(400).json({ error: `输入格式有误：${error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}` }); res.status(500).json({ error: safeError(error) }); });
  return app;
}
