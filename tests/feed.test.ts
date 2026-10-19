import { fixtureAssessment } from './analysis-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventTime, feedSources, heatScore, publishedTime, selectSignals, selectTopSignals, signalSources, type FeedFilters } from '../shared/feed.js';
import { currentSignal, historicalSignal } from '../shared/freshness.js';
import type { Candidate, Evidence, Rule, Signal } from '../shared/types.js';
import { analysisSchema, validateBatch } from '../server/ai.js';
import { dashboard } from '../server/app.js';
import { Store } from '../server/db.js';
import { expireContent } from '../server/retention.js';
import { ingest } from '../server/sources.js';

const now = Date.now();
const hoursAgo = (hours: number) => new Date(now - hours * 3600000).toISOString();
const filters: FeedFilters = { source: 'all', importance: 'all', keyword: 'all', timeRange: 'all', status: 'all', search: '', sort: 'heat' };
function signal(id: string, patch: Partial<Signal> = {}, evidence: Partial<Evidence> = {}): Signal {
  return { id, eventKey: id, title: `Release ${id}`, summary: 'A substantial new capability for developers.', entity: id, version: '1', eventType: 'release', occurredAt: hoursAgo(2), status: 'confirmed', reason: 'Official original', attention: 80, attentionReason: 'New capabilities', importance: 'medium', importanceReason: 'A useful update', tags: ['coding'], ruleIds: ['a', 'b'], firstSeenAt: hoursAgo(1), updatedAt: hoursAgo(0), isNewsworthy: true, isNewEvent: true, screeningVersion: 2, twitterFilterVersion: 1,
    evidence: [{ id: `ev-${id}`, sourceId: 'bing', sourceKind: 'web', contentKind: 'article', externalId: id, url: `https://openai.com/news/${id}`, finalUrl: `https://openai.com/news/${id}`, title: 'Original release', text: 'An original release announcement with concrete changes and enough readable material. '.repeat(3), publishedAt: hoursAgo(2), fetchedAt: hoursAgo(1), author: 'OpenAI', official: true, original: true, contentHash: id, discoveredBy: ['bing', 'sogou'], quality: { version: 2, decision: 'eligible', reason: 'Original material' }, ...evidence }], ...patch };
}
const ids = (items: Signal[], patch: Partial<FeedFilters> = {}) => selectSignals(items, { ...filters, ...patch }, now).map(item => item.id);

test('16 日最近 6 小时不能收录 14 日热点，即使刚发现或重复抓取；四种排序一致', () => {
  const clock = Date.parse('2026-10-16T18:00:00+08:00');
  const old = signal('oct14', { occurredAt: '2026-10-14T12:00:00+08:00', firstSeenAt: '2026-10-16T17:50:00+08:00', updatedAt: '2026-10-16T17:59:00+08:00' }, { publishedAt: '2026-10-14T12:00:00+08:00', fetchedAt: '2026-10-16T17:59:00+08:00' });
  const recent = signal('oct16', { occurredAt: '2026-10-16T17:00:00+08:00', firstSeenAt: '2026-10-16T17:30:00+08:00' }, { publishedAt: '2026-10-16T17:00:00+08:00', fetchedAt: '2026-10-16T17:30:00+08:00' });
  for (const sort of ['heat', 'published', 'discovered', 'importance'] as const) {
    assert.deepEqual(selectSignals([old, recent], { ...filters, timeRange: '6h', sort }, clock).map(item => item.id), ['oct16']);
  }
});

test('四个筛选条件取交集，来源同时匹配平台与发现渠道，暂停的历史关键词仍可查看', () => {
  const video = signal('video', { importance: 'high', ruleIds: ['paused'], occurredAt: hoursAgo(0.5), firstSeenAt: hoursAgo(0.5) }, { sourceId: 'bilibili', finalUrl: 'https://www.bilibili.com/video/BV123456/', author: 'creator', contentKind: 'description', official: false, publishedAt: hoursAgo(0.5) });
  const normal = signal('normal');
  const others = [signal('wrong-importance', { importance: 'low' }, video.evidence[0]), signal('wrong-keyword', { importance: 'high', ruleIds: ['other'] }, video.evidence[0]), signal('too-old', { importance: 'high', ruleIds: ['paused'], occurredAt: hoursAgo(2), firstSeenAt: hoursAgo(0.1) }, video.evidence[0])];
  assert.deepEqual(ids([video, normal, ...others], { source: 'bing', importance: 'high', keyword: 'paused', timeRange: '1h' }), ['video']);
  assert.ok(signalSources(video).includes('bilibili'));
  assert.ok(signalSources(video).includes('sogou'));
  assert.deepEqual(ids([normal], { source: 'hackernews' }), []);
  assert.ok(signalSources(signal('hn', {}, { finalUrl: 'https://news.ycombinator.com/item?id=123' })).includes('hackernews'));
  assert.ok(feedSources([], [normal]).some(source => source.id === 'bing' && source.name === 'Bing'));
});

test('1 小时、6 小时、24 小时、5 天按事件时间包含精确边界，超过一毫秒即排除', () => {
  for (const [timeRange, hours] of [['1h', 1], ['6h', 6], ['24h', 24], ['5d', 120]] as const) {
    const edge = signal('edge', { occurredAt: hoursAgo(hours), firstSeenAt: hoursAgo(Math.max(0, hours - 1)) }, { publishedAt: hoursAgo(hours) });
    const outsideTime = new Date(now - hours * 3600000 - 1).toISOString();
    const outside = signal('outside', { occurredAt: outsideTime, firstSeenAt: hoursAgo(0.1), updatedAt: hoursAgo(0) }, { publishedAt: outsideTime, fetchedAt: hoursAgo(0) });
    assert.deepEqual(ids([edge, outside], { timeRange }), ['edge']);
  }
});

test('缺少事件时间才使用原始发布时间；重发、更新、未知日期和未来日期不冒充新事件', () => {
  const recent = signal('recent', { occurredAt: null }, { publishedAt: hoursAgo(1) });
  const old = signal('old', { occurredAt: null, firstSeenAt: hoursAgo(0.1), updatedAt: hoursAgo(0) }, { publishedAt: hoursAgo(48), fetchedAt: hoursAgo(0) });
  const retelling = signal('retelling', { occurredAt: hoursAgo(48), firstSeenAt: hoursAgo(0.1) }, { publishedAt: hoursAgo(1) });
  const unknown = signal('unknown', { occurredAt: null }, { publishedAt: null, updatedAt: hoursAgo(0) });
  const invalid = signal('invalid', { occurredAt: 'invalid' }, { publishedAt: hoursAgo(1) });
  const future = signal('future', { occurredAt: new Date(now + 60000).toISOString() }, { publishedAt: hoursAgo(1) });
  assert.equal(eventTime(recent, now), Date.parse(hoursAgo(1)));
  assert.deepEqual(ids([old, recent, retelling, unknown, invalid, future], { timeRange: '6h' }), ['recent']);
});

test('最近 5 天排除更早历史，全部时间仍可查看原本合格的历史信号', () => {
  const current = signal('current', { firstSeenAt: hoursAgo(95), occurredAt: hoursAgo(96) }, { publishedAt: hoursAgo(96) });
  const history = signal('history', { firstSeenAt: hoursAgo(144), occurredAt: hoursAgo(145) }, { publishedAt: hoursAgo(145) });
  const older = signal('older', { firstSeenAt: hoursAgo(192), occurredAt: hoursAgo(193) }, { publishedAt: hoursAgo(193) });
  assert.equal(currentSignal(history, now), false);
  assert.equal(historicalSignal(history, now), true);
  assert.deepEqual(ids([current, history, older], { timeRange: '5d' }), ['current']);
  assert.deepEqual(ids([history, older]), ['history', 'older']);
});

test('北京时间与 UTC 的同一时刻结果相同，时间范围使用滚动小时而非自然日', () => {
  const clock = Date.parse('2026-10-16T18:00:00+08:00');
  const beijing = signal('beijing', { occurredAt: '2026-10-16T12:00:00+08:00', firstSeenAt: '2026-10-16T17:00:00+08:00' }, { publishedAt: '2026-10-16T12:00:00+08:00' });
  const utc = signal('utc', { occurredAt: '2026-10-16T04:00:00Z', firstSeenAt: '2026-10-16T09:00:00Z' }, { publishedAt: '2026-10-16T04:00:00Z' });
  assert.equal(eventTime(beijing, clock), eventTime(utc, clock));
  assert.deepEqual(selectSignals([beijing, utc], { ...filters, timeRange: '6h' }, clock).map(item => item.id), ['beijing', 'utc']);
});

test('热度综合包含浏览量、去重并取最热原帖，零互动和指标缺失有区别', () => {
  const post = signal('post', {}, { likes: 10, reposts: 5, replies: 2, views: 1000 });
  assert.equal(heatScore(post), 32);
  assert.equal(heatScore({ ...post, evidence: [...post.evidence, { ...post.evidence[0], discoveredBy: ['sogou'] }] }), 32);
  const views = signal('views', {}, { views: 10000 });
  assert.deepEqual(ids([post, views]), ['views', 'post']);
  assert.deepEqual(ids([signal('unknown'), signal('zero', {}, { likes: 0 })]), ['zero', 'unknown']);
  assert.equal(heatScore(signal('invalid', {}, { likes: -1, views: NaN })), null);
});

test('热门展示最多一百条，收藏和书签较多的信息优先，未知指标排后',()=>{
  const inputs=Array.from({length:150},(_,index)=>signal('item-'+index,{}, {likes:index}));
  const favorite=signal('favorite',{}, {favorites:1000}),bookmark=signal('bookmark',{}, {bookmarks:900});
  const selected=selectTopSignals([...inputs,favorite,bookmark,signal('unknown')],filters,now);
  assert.equal(selected.total,153);assert.equal(selected.items.length,100);
  assert.deepEqual(selected.items.slice(0,2).map(item=>item.id),['favorite','bookmark']);
  assert.ok(!selected.items.some(item=>item.id==='unknown'||item.id==='item-0'));
  assert.equal(selectTopSignals(inputs.slice(0,4),filters,now).items.length,4);
});

test('先筛选来源和关键词再取热度前一百，其他排序只重排热门集合',()=>{
  const other=Array.from({length:110},(_,index)=>signal('other-'+index,{ruleIds:['other']},{likes:10000+index}));
  const target=Array.from({length:105},(_,index)=>signal('target-'+index,{ruleIds:['target']},{likes:index}));
  const selected=selectTopSignals([...other,...target],{...filters,keyword:'target'},now);
  assert.equal(selected.total,105);assert.equal(selected.items.length,100);assert.ok(selected.items.every(item=>item.id.startsWith('target-')));
  const lowNew=signal('low-new',{occurredAt:hoursAgo(0.01)},{publishedAt:hoursAgo(0.01),likes:0});
  const full=[...other,lowNew];
  const popular=selectTopSignals(full,filters,now),recent=selectTopSignals(full,{...filters,sort:'published'},now);
  assert.deepEqual(new Set(popular.items.map(item=>item.id)),new Set(recent.items.map(item=>item.id)));
  assert.ok(!recent.items.some(item=>item.id==='low-new'));
});

test('播放、收藏、投币与弹幕共同参与热度，重复证据不会累加',()=>{
  const entry=signal('engaged',{}, {likes:10,reposts:2,replies:3,views:1000,bookmarks:4,favorites:5,coins:6,danmaku:7});
  assert.equal(heatScore(entry),64);
  assert.equal(heatScore({...entry,evidence:[...entry.evidence,{...entry.evidence[0],id:'duplicate'}]}),64);
});

test('发布排序使用原文日期，发现排序使用首次抓取，重要度四级且同分顺序稳定', () => {
  const a = signal('a', { importance: 'urgent', firstSeenAt: hoursAgo(1), occurredAt: hoursAgo(0) }, { publishedAt: hoursAgo(3) });
  const b = signal('b', { importance: 'low', firstSeenAt: hoursAgo(0.5) }, { publishedAt: hoursAgo(2) });
  assert.equal(publishedTime(a, now), Date.parse(hoursAgo(3)));
  assert.deepEqual(ids([a, b], { sort: 'published' }), ['b', 'a']);
  assert.deepEqual(ids([a, b], { sort: 'discovered' }), ['b', 'a']);
  assert.deepEqual(ids([b, a], { sort: 'importance' }), ['a', 'b']);
  const levels = ['low', 'medium', 'high', 'urgent'] as const;
  assert.deepEqual(ids(levels.map(importance => signal(importance, { importance })), { sort: 'importance' }), ['urgent', 'high', 'medium', 'low']);
  assert.deepEqual(ids([signal('b'), signal('a')]), ['a', 'b']);
});

test('历史检索只恢复正常过期，不放出旧闻、拒绝项、质量审计项或失效的 X 门槛', () => {
  const history = signal('history', { firstSeenAt: hoursAgo(144), occurredAt: hoursAgo(145), auditOnly: true, auditReason: '超过 5 天，自动退出热点列表' }, { publishedAt: hoursAgo(145) });
  assert.equal(historicalSignal(history, now), true);
  for (const patch of [{ status: 'rejected' as const }, { isNewEvent: false }, { isNewsworthy: false }, { auditReason: '没有选题价值' }, { firstSeenAt: hoursAgo(1) }]) assert.equal(historicalSignal({ ...history, ...patch }, now), false);
  const x = { ...history, evidence: [{ ...history.evidence[0], sourceKind: 'x' as const, contentKind: 'post' as const, postType: 'original' as const, finalUrl: 'https://x.com/author/status/1', likes: 10, reposts: 5, views: 500, authorFollowers: 100, quality: { version: 2, decision: 'filtered' as const, reason: '超过 5 天，自动排除并停止重试' } }] };
  assert.equal(historicalSignal(x, now), true);
  assert.equal(historicalSignal({ ...x, evidence: [{ ...x.evidence[0], likes: 1 }] }, now), false);
});

test('历史接口覆盖超过 200 条记录，清理过期不会覆盖原有质量排除原因', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 205; i++) store.put('events', `${i}`, signal(`${i}`));
    const history = signal('history', { firstSeenAt: hoursAgo(144), occurredAt: hoursAgo(145) }, { publishedAt: hoursAgo(145) });
    store.put('events', history.id, history);
    store.put('events', 'rejected', { ...history, id: 'rejected', auditOnly: true, auditReason: '质量排除' });
    expireContent(store, now);
    assert.equal(dashboard(store).events.length, 205);
    assert.equal(dashboard(store, true).events.length, 206);
    assert.equal(store.get<Signal>('events', 'rejected')?.auditReason, '质量排除');
  } finally { store.close(); }
});

test('重复抓取和正文更新保留首次发现，AI 保存重要性且不要求关键词评分', () => {
  const store = new Store(':memory:');
  try {
    const ev = signal('original').evidence[0];
    ingest(store, { ...ev, fetchedAt: hoursAgo(1) });
    ingest(store, { ...ev, fetchedAt: hoursAgo(0) });
    ingest(store, { ...ev, fetchedAt: hoursAgo(0), contentHash: 'updated' });
    const saved = store.get<Candidate>('candidates', ev.id)!;
    assert.equal(saved.firstDiscoveredAt, hoursAgo(1));
    const rule: Rule = { id: 'a', name: 'Coding', query: 'coding release', kind: 'keyword', enabled: true, notify: false, createdAt: hoursAgo(3), baselineAt: hoursAgo(3), nextRunAt: hoursAgo(0), lastRunAt: null };
    const event = { title: 'New release', summary: 'New capability', entity: 'model', version: '1', eventType: 'release', occurredAt: ev.publishedAt, isNewsworthy: true, isNewEvent: true, status: 'confirmed', reason: 'Official source', attention: 10, attentionReason: 'Separate editorial score', importance: 'high', importanceReason: 'Broad impact', tags: [], evidenceIds: [ev.id], ruleIds: ['a'], existingEventId: null };
    const data = analysisSchema.parse({ events: [{...event,ruleAssessments:[fixtureAssessment(saved,rule)]}], excludedEvidenceIds: [] });
    const result = validateBatch(data, [saved], [rule], [], now).signals[0];
    assert.equal(result.importance, 'high');
    assert.equal(result.firstSeenAt, hoursAgo(1));
    const prior = { ...result, ruleIds: ['a', 'paused'],ruleAssessments:[...result.ruleAssessments!,{...result.ruleAssessments![0],ruleId:'paused'}] };
    const merged = validateBatch(data, [saved], [rule], [prior], now).signals[0];
    assert.deepEqual([...merged.ruleIds].sort(), ['a', 'paused']);
  } finally { store.close(); }
});
