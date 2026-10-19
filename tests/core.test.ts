import { fixtureAssessment } from './analysis-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.js';
import { publicAddress, publicUrl, type HttpClient, type HttpDocument } from '../server/http.js';
import { article, hash, makeEvidence, parseFeed, parseSearch } from '../server/parse.js';
import { Collector, ingest } from '../server/sources.js';
import { Analyzer, analysisSchema, validateAnalysis } from '../server/ai.js';
import { eligible, Mailer, queueNotifications } from '../server/mail.js';
import { Runner } from '../server/runner.js';
import type { Candidate, Evidence, Rule, Signal, Source } from '../shared/types.js';
const source: Source = { id: 'test-feed', name: 'Test', kind: 'rss', url: 'https://openai.com/news/rss.xml', enabled: true, official: true };
const now = Date.now(); const date = new Date(now - 60000).toISOString();
const evidence = (): Evidence => makeEvidence(source, { url: 'https://openai.com/news/test-release', title: 'Test release', text: 'A test-only release announcement with enough original text to exercise evidence validation. This fixture never appears in the app.', publishedAt: date, original: true, official: true });
const rule = (): Rule => ({ id: 'rule', name: 'Test release', query: 'test release', kind: 'keyword', enabled: true, notify: true, createdAt: new Date(now - 3600000).toISOString(), baselineAt: new Date(now - 3600000).toISOString(), nextRunAt: new Date(now - 1000).toISOString(), lastRunAt: null });
const analysis = (ev: Evidence) => analysisSchema.parse({ events: [{ title: 'Test release', summary: 'Fixture', entity: 'test-model', version: '1', eventType: 'release', occurredAt: date, isNewsworthy:true, isNewEvent:true, status: 'confirmed', reason: 'Fixture original', attention: 80, attentionReason: 'Fixture', importance: 'medium', importanceReason: 'Fixture impact', tags: ['test'], evidenceIds: [ev.id], ruleIds: ['rule'], ruleAssessments:[fixtureAssessment(ev,rule())], existingEventId: null }], excludedEvidenceIds: [] });
const signal = (): Signal => validateAnalysis(analysis(evidence()), [evidence()], [rule()], [])[0];
function doc(text: string, url = source.url): HttpDocument { return { status: 200, headers: {}, text, url }; }
test('公共地址检查拒绝私网、环回、IPv6 映射、凭据和非标准端口', () => {
  for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://user:pass@example.com/', 'http://example.com:3000/']) assert.throws(() => publicUrl(url));
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('169.254.169.254'), false); assert.equal(publicAddress('203.0.113.5'), false); assert.equal(publicAddress('fc00::1'), false);
});
test('Bing 只抽取自然结果并解码跳转，排除搜索 AI 摘要', () => {
  const url = 'https://openai.com/news/update?utm_source=bing'; const encoded = `a1${Buffer.from(url).toString('base64url')}`;
  const values = parseSearch(`<html><body><div>AI summary: unverified</div><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}">Actual source</a></h2><div class="b_caption"><p>Snippet</p></div></li></body></html>`, { ...source, id: 'bing', kind: 'web' }, 'https://www.bing.com/search');
  assert.equal(values.length, 1); assert.equal(values[0].url, 'https://openai.com/news/update'); assert.equal(values[0].original, false); assert.equal(values[0].text, 'Snippet');
  assert.throws(() => parseSearch('<body>Verify you are human captcha</body>', { ...source, id: 'bing', kind: 'web' }, source.url));
  assert.throws(() => parseSearch('<body>New unknown layout</body>', { ...source, id: 'bing', kind: 'web' }, source.url));
  assert.equal(parseSearch('<body>No results found</body>', { ...source, id: 'bing', kind: 'web' }, source.url).length, 0);
});
test('RSS 与 Atom 保留 ID 字符串、发布日期、属性，拒绝实体声明', () => {
  const rss = `<rss version="2.0"><channel><item><title>News</title><link>https://openai.com/news/test</link><guid>99999999999999999999</guid><pubDate>${new Date(now - 60000).toUTCString()}</pubDate><description><![CDATA[<p>${'Original content '.repeat(10)}</p>]]></description></item></channel></rss>`;
  assert.equal(parseFeed(rss, source)[0].externalId, '99999999999999999999'); assert.equal(parseFeed(rss, source)[0].official, true);
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>12345678901234567890</id><title>Atom</title><published>${date}</published><link href="https://openai.com/news/atom" rel="alternate"/><summary>Atom content</summary></entry></feed>`;
  assert.equal(parseFeed(atom, source)[0].url, 'https://openai.com/news/atom'); assert.equal(parseFeed(atom, source)[0].externalId, '12345678901234567890');
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY a SYSTEM "file:///test">]><rss/>', source)); assert.throws(() => parseFeed('<html/>', source));
});
test('原文提取读取发布日期但不执行脚本，移除导航', () => { const value = article(`<html><head><meta property="article:published_time" content="${date}"></head><body><nav>REMOVE</nav><article><h1>Title</h1><p>${'Body '.repeat(35)}</p></article><script>throw new Error('unsafe')</script></body></html>`, 'https://openai.com/news/test'); assert.equal(value.publishedAt, date); assert.ok(!value.text.includes('unsafe')); assert.ok(!value.text.includes('REMOVE')); });
test('文章拒绝访问不抹掉已取得的发布源摘要，保留材料类型与读取限制', async () => {
  const store = new Store(':memory:'); const ev = { ...evidence(), contentKind: 'feed' as const };
  try {
    store.put('feeds', source.id, { items: [ev] });
    const collector = new Collector(store, { request: async () => ({ ...doc('blocked'), status: 403 }) }, '', false);
    const value = await collector.enrich({ ...ev, original: false });
    assert.equal(value.original, true); assert.equal(value.official, true); assert.equal(value.contentKind, 'feed'); assert.match(value.text, /文章全文未读取/);
    const search = await collector.enrich({ ...ev, sourceKind: 'web', original: false }); assert.equal(search.original, false);
  } finally {store.close();}
});
test('模型不能虚构证据；仿冒/摘要与无依据日期不能变为已核实', () => {
  const ev = evidence(); assert.equal(validateAnalysis(analysis(ev), [ev], [rule()], [])[0].status, 'confirmed');
  assert.equal(validateAnalysis(analysis(ev), [{ ...ev, official: false, original: false }], [rule()], [])[0].status, 'rejected');
  const noDate = analysis(ev); noDate.events[0].occurredAt = null; assert.equal(validateAnalysis(noDate, [ev], [rule()], [])[0].status, 'pending');
  const invented = analysis(ev); invented.events[0].evidenceIds = ['invented']; assert.throws(() => validateAnalysis(invented, [ev], [rule()], []));
  const unrelated = analysis(ev); unrelated.events[0].ruleIds = []; assert.equal(validateAnalysis(unrelated, [ev], [rule()], [])[0].status, 'rejected');
});
test('供应商在 HTTP 200 中返回错误时仍拒绝分析，不产生事件', async () => {
  const store = new Store(':memory:'); try {
    store.put('state', 'settings', { ...store.settings(), model: 'test/model' }); store.put('state', 'modelChecked', { model: 'test/model', at: Date.now(), reasoningEffort: null,reasoningPolicyVersion:3 });
    const http: HttpClient = { request: async () => doc(JSON.stringify({ error: { message: 'upstream timed out' } })) };
    await assert.rejects(new Analyzer(store, http, 'test-only-key').analyze([evidence()], [rule()], []), /upstream timed out/);
    assert.equal(store.list('events').length, 0);
  } finally { store.close(); }
});
test('无关候选必须明确排除，不能遗漏或同时归入事件', () => {
  const ev = evidence(); const other = { ...ev, id: 'unrelated' }; const data = analysis(ev);
  assert.throws(() => validateAnalysis(data, [ev, other], [rule()], []), /完整处理/);
  data.excludedEvidenceIds = [other.id]; data.exclusions=[{evidenceId:other.id,category:'unrelated',reason:'Unrelated fixture'}]; assert.equal(validateAnalysis(data, [ev, other], [rule()], []).length, 1);
  data.excludedEvidenceIds = [ev.id]; assert.throws(() => validateAnalysis(data, [ev], [rule()], []), /冲突/);
});
test('输出截断不产生事件，但仍记录供应商返回的 token 用量', async () => {
  const store = new Store(':memory:'); try {
    store.put('state', 'settings', { ...store.settings(), model: 'test/model' }); store.put('state', 'modelChecked', { model: 'test/model', at: Date.now(), reasoningEffort: null,reasoningPolicyVersion:3 });
    const http: HttpClient = { request: async () => doc(JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { total_tokens: 123 } })) };
    await assert.rejects(new Analyzer(store, http, 'test-only-key').analyze([evidence()], [rule()], []), /截断/);
    assert.equal(store.usage().aiTokens, 123); assert.equal(store.list('events').length, 0);
  } finally {store.close();}
});
test('重新核实复用候选，不重复调用 X 或网页搜索', async () => {
  const store = new Store(':memory:'); try {
    store.put('rules', 'rule', rule()); store.put('sources',source.id,source); const ev = evidence(); ingest(store, ev);
    const http: HttpClient = { request: async () => { throw new Error('must not collect'); } };
    const run = await new Runner(store, new Collector(store, http, '', false), { analyze: async values => ({ signals: validateAnalysis(analysis(values[0]), values, [rule()], []), excludedEvidenceIds: [] }) }).scan('重新核实');
    assert.equal(run?.analyzed, 1); assert.equal(run?.newSignals, 1); assert.ok(run?.sources.every(item => ['cached', 'disabled'].includes(item.status)));
  } finally { store.close(); }
});
test('分批审核保留已成功批次，后续批次失败不重做或丢掉结果', async () => {
  const store = new Store(':memory:'); let calls = 0;
  try {
    store.put('rules', 'rule', rule()); store.put('sources',source.id,source);
    for(let i=0;i<30;i++) ingest(store, { ...evidence(), id: `batch-${i}`, url:`https://openai.com/news/batch-${i}`, finalUrl:`https://openai.com/news/batch-${i}`, text: 'Original content '.repeat(60) });
    const runner = new Runner(store, new Collector(store, { request: async () => { throw new Error('unused'); } }, '', false), { analyze: async batch => { calls++; assert.equal(batch.length, 8); if(calls === 2) throw new Error('second batch offline'); return { signals: [], excludedEvidenceIds: batch.map(item=>item.id) }; } });
    const run = await runner.scan('重新核实'); assert.equal(run?.status, 'partial'); assert.equal(run?.analyzed, 8); assert.equal(calls, 2);
    const saved=store.list<Candidate>('candidates'); assert.equal(saved.filter(item=>item.processedHash === item.contentHash).length, 8);
    assert.equal(saved.filter(item=>!item.processedHash && item.attempts === 1).length, 8);
  } finally {store.close();}
});
test('相同版本稳定合并，不同版本不能被 AI 强制合并', () => {
  const ev = evidence(); const old = signal(); const same = analysis(ev); same.events[0].existingEventId = old.id;
  assert.equal(validateAnalysis(same, [ev], [rule()], [old])[0].id, old.id);
  same.events[0].version = '2'; assert.throws(() => validateAnalysis(same, [ev], [rule()], [old]));
  same.events[0].existingEventId = null; assert.notEqual(validateAnalysis(same, [ev], [rule()], [old])[0].id, old.id);
});
test('合并同一事件时保留已取得的原始证据，后来的摘要不会抹掉确认依据', () => {
  const old = signal(); const snippet = { ...evidence(), id: 'new-snippet', original: false, official: false };
  const next = analysis(snippet); next.events[0].existingEventId = old.id; next.events[0].ruleAssessments=[fixtureAssessment(old.evidence[0],rule())];
  const merged = validateAnalysis(next, [snippet], [rule()], [old])[0];
  assert.equal(merged.status, 'confirmed'); assert.equal(merged.evidence.length, 1); assert.equal(merged.evidence[0].original,true);
  next.events[0].status = 'pending'; assert.equal(validateAnalysis(next, [snippet], [rule()], [old])[0].status, 'pending');
});
test('网页查询用于补证，不强制缩窄至一天；验证码明确报错', async () => {
  const store = new Store(':memory:'); const urls: URL[] = [];
  try {
    const web = { ...source, id: 'bing', kind: 'web' as const, url: 'https://www.bing.com/search' };
    const collector=new Collector(store,{request:async raw=>{urls.push(new URL(raw));return doc('<body>Verify you are human captcha</body>',raw);}},'',false);
    await assert.rejects(collector.web(web,'model release'),/验证/);
    assert.equal(urls.length,1);assert.equal(urls[0].searchParams.has('filters'),false);
  } finally { store.close(); }
});

test('首次基线、待核实、暂停和历史事件不通知；升级可通知并去重', () => {
  const store = new Store(':memory:'); try {
    const value = signal(); const r = rule(); assert.equal(eligible(value, { ...r, baselineAt: null }), false); assert.equal(eligible({ ...value, status: 'pending' }, r), false); assert.equal(eligible(value, { ...r, enabled: false }), false); assert.equal(eligible({ ...value, occurredAt: new Date(now - 7200000).toISOString() }, r), false);
    assert.equal(queueNotifications(store, [value], [r]), 1); assert.equal(queueNotifications(store, [value], [r]), 0);
  } finally { store.close(); }
});
test('邮件失败保留重试，同一 Message-ID 重试后才标为提交', async () => {
  const store = new Store(':memory:'); try { store.put('state', 'settings', { ...store.settings(), recipient: 'test@example.com' }); store.put('rules', 'rule', rule()); store.put('events', signal().id, signal()); queueNotifications(store, [signal()], [rule()], now); let calls = 0; const ids: unknown[] = [];
    const mailer = new Mailer(store, { verify: async () => true, sendMail: async message => { ids.push(message.messageId); if (++calls === 1) throw new Error('temporary failure'); return { accepted: ['test@example.com'] }; } });
    await mailer.flush(now, true, true); const failed = store.list<{ status: string; nextAttemptAt: string }>('mail')[0]; assert.equal(failed.status, 'retry'); await mailer.flush(Date.parse(failed.nextAttemptAt), true, true); assert.equal(store.list<{ status: string }>('mail')[0].status, 'submitted'); assert.equal(ids[0], ids[1]);
  } finally { store.close(); }
});
test('配额与租约原子限制；陈旧租约可恢复', () => { const store = new Store(':memory:'); try { assert.equal(store.reserve('xRequests', 2, 3), true); assert.equal(store.reserve('xRequests', 2, 3), false); assert.equal(store.usage().xRequests, 2); assert.equal(store.lease('scan', 'one', 10000), true); assert.equal(store.lease('scan', 'two', 10000), false); store.release('scan', 'one'); assert.equal(store.lease('scan', 'two', 10000), true); } finally { store.close(); } });
test('X 采用 Latest 和 Unix 秒；空页继续，分页上限保留窗口与数据', async () => {
  const store = new Store(':memory:'); const urls: URL[] = []; let calls = 0; const xSource = { ...source, id: 'twitter', kind: 'x' as const, official: false };
  const http: HttpClient = { request: async raw => { const url = new URL(raw); urls.push(url); calls++; const tweet = { id: '99999999999999999999', url: 'https://x.com/test/status/99999999999999999999', text: 'Test post', createdAt: date, author: { id: '12345678901234567890', userName: 'test' } }; return doc(JSON.stringify({ tweets: calls === 1 ? [] : [tweet], has_next_page: calls < 4, next_cursor: `cursor-${calls}` })); } };
  try { const collector = new Collector(store, http, 'test-only-key', false); const first = await collector.x(xSource, 'test release', now - 3600000); assert.equal(first.result.status, 'partial'); assert.equal(first.items[0].externalId, '99999999999999999999'); assert.equal(urls[0].searchParams.get('queryType'), 'Latest'); assert.match(urls[0].searchParams.get('query')!, /since_time:\d{10} until_time:\d{10}/); assert.equal(urls[1].searchParams.get('cursor'), 'cursor-1'); assert.ok(store.list<Candidate>('candidates').length);
    const completed = await collector.x(xSource, 'test release', now - 3600000); assert.equal(urls[3].searchParams.get('cursor'), 'cursor-3'); assert.equal(completed.result.status, 'success'); const checkpoint = store.get<{ until?: number }>('checkpoints', hash('x:test release')); assert.equal(checkpoint?.until, undefined);
  } finally { store.close(); }
});
test('X 重复游标不死循环，已获取的候选不会丢失', async () => { const store = new Store(':memory:'); let calls = 0; const xSource = { ...source, id: 'twitter', kind: 'x' as const }; const http: HttpClient = { request: async () => { calls++; return doc(JSON.stringify({ tweets: [{ id: '123', url: 'https://x.com/test/status/123', text: 'A post', createdAt: date, author: { id: '456', userName: 'test' } }], has_next_page: true, next_cursor: 'same' })); } }; try { await assert.rejects(new Collector(store, http, 'test-only-key', false).x(xSource, 'test', now - 3600000), /游标/); assert.equal(calls, 2); assert.equal(store.list<Candidate>('candidates').length, 1); } finally { store.close(); } });
test('原文分析缓存不因相同 RSS 再次采集被重置', () => { const store = new Store(':memory:'); try { const ev = evidence(); ingest(store, ev); const saved = store.get<Candidate>('candidates', ev.id)!; store.put('candidates', ev.id, { ...saved, text: 'Enriched', contentHash: 'enriched', processedHash: 'enriched', attempts: 1 }); ingest(store, ev); assert.equal(store.get<Candidate>('candidates', ev.id)?.processedHash, 'enriched'); assert.equal(store.get<Candidate>('candidates', ev.id)?.text, 'Enriched'); } finally { store.close(); } });
test('多源单路失败仍保存其他候选，AI 失败保留待分析与 30 分钟调度', async () => {
  const store = new Store(':memory:'); try {
    for (const item of store.list<Source>('sources')) store.remove('sources', item.id);
    store.put('sources', 'good', { ...source, id: 'good' }); store.put('sources', 'bad', { ...source, id: 'bad', url: 'https://example.com/bad' }); store.put('rules', 'rule', { ...rule(), baselineAt: null });
    const xml = `<rss><channel><item><title>Test release</title><link>https://openai.com/news/test</link><pubDate>${date}</pubDate><description>${'Original '.repeat(100)}</description></item></channel></rss>`;
    const http: HttpClient = { request: async raw => { if (raw.includes('/bad')) throw new Error('offline'); return doc(xml); } };
    const runner = new Runner(store, new Collector(store, http, '', false), { analyze: async () => { throw new Error('AI unavailable'); } }); const run = await runner.scan('测试');
    assert.equal(run?.status, 'partial'); assert.equal(run?.sources.length, 2); assert.equal(store.list<Candidate>('candidates').length, 1); assert.equal(store.list<Candidate>('candidates')[0].processedHash, null); const saved = store.get<Rule>('rules', 'rule')!; assert.equal(Date.parse(saved.nextRunAt) - Date.parse(saved.lastRunAt!), 30 * 60000); assert.ok(saved.baselineAt);
  } finally { store.close(); }
});
