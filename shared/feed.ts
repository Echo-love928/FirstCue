import type { Evidence, Importance, Signal, Source } from './types.js';
import { platformOf } from './discovery.js';
import { FRESHNESS_HOURS, historicalSignal, timestamp } from './freshness.js';
import { interactionScore } from './engagement.js';
import { directAssessments } from './relevance.js';

export const importanceLabels: Record<Importance, string> = { urgent: '紧急', high: '高', medium: '中', low: '低' };
export const importanceRanks: Record<Importance, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
export const timeRanges = { '1h': '最近 1 小时', '6h': '最近 6 小时', '24h': '最近 24 小时', '5d': '最近 5 天', all: '全部时间' };
export const sortLabels = { heat: '热度综合', published: '最新发布', discovered: '最新发现', importance: '重要度' };
export type FeedSort = keyof typeof sortLabels;
export type TimeRange = keyof typeof timeRanges;
export const DEFAULT_TIME_RANGE:TimeRange='5d';
export const FEED_LIMIT = 100;
export interface FeedFilters {
  source: string;
  importance: Importance | 'all';
  keyword: string;
  timeRange: TimeRange;
  status: 'all' | 'confirmed' | 'pending';
  search: string;
  sort: FeedSort;
}
const rangeHours: Record<TimeRange, number> = { '1h': 1, '6h': 6, '24h': 24, '5d': FRESHNESS_HOURS, all: Infinity };
const sourceNames: Record<string, string> = { twitter: 'Twitter', bing: 'Bing', hackernews: 'HackerNews', sogou: '搜狗', baidu: '百度', bilibili: 'B站', weibo: '微博', web: '其他网页', rss: 'RSS 订阅' };
const normalizeSource = (id: string) => id === 'x' ? 'twitter' : /^(hn|hacker-news)$/i.test(id) ? 'hackernews' : id;

export function signalSources(signal: Signal): string[] {
  return [...new Set(signal.evidence.flatMap(item => {
    const platform = platformOf(item);
    const ids = [item.sourceId, ...(item.discoveredBy || []), platform === 'x' ? 'twitter' : platform];
    if (new URL(item.finalUrl).hostname === 'news.ycombinator.com') ids.push('hackernews');
    return ids.map(normalizeSource);
  }))];
}
export function feedSources(sources: Source[], signals: Signal[]): { id: string; name: string }[] {
  const names = new Map(Object.entries(sourceNames));
  for (const source of sources) if (!names.has(normalizeSource(source.id))) names.set(normalizeSource(source.id), source.name);
  for (const signal of signals) for (const id of signalSources(signal)) if (!names.has(id)) names.set(id, id);
  return [...names].map(([id, name]) => ({ id, name }));
}
function originalEvidence(item: Evidence): boolean {
  return item.original && !item.supportingOnly && (item.quality?.decision === 'eligible' || item.quality?.reason === '超过 5 天，自动排除并停止重试');
}
export function publishedTime(signal: Signal, now = Date.now()): number | null {
  const dates = signal.evidence.filter(originalEvidence).map(item => timestamp(item.publishedAt, now)).filter((value): value is number => value !== null);
  return dates.length ? Math.min(...dates) : null;
}
// Discovery, re-fetching and edits must never make an older event recent.
export function eventTime(signal: Signal, now = Date.now()): number | null {
  if(signal.discoveryOnly)return timestamp(signal.occurredAt||signal.firstSeenAt,now);
  return signal.occurredAt ? timestamp(signal.occurredAt, now) : publishedTime(signal, now);
}
// Use the strongest original post; duplicate discovery channels cannot inflate heat.
// The score is a weighted interaction index, not a view count or an AI judgment.
export function heatScore(signal: Signal): number | null {
  const values = signal.evidence.filter(originalEvidence).flatMap(item => {
    const score = interactionScore(item);
    return score === null ? [] : [score];
  });
  return values.length ? Math.max(...values) : null;
}
// The displayed author and counts always belong to the same original evidence.
export function primaryEvidence(signal: Signal): Evidence | undefined {
  return signal.evidence.filter(originalEvidence).sort((a, b) => (interactionScore(b) ?? -1) - (interactionScore(a) ?? -1))[0];
}
export function selectSignals(signals: Signal[], filters: FeedFilters, now = Date.now()): Signal[] {
  const search = filters.search.trim().toLowerCase();
  const selected = signals.filter(item => {
    const occurred = eventTime(item, now);
    return historicalSignal(item, now)
      && (filters.status === 'all' || item.status === filters.status)
      && (filters.source === 'all' || signalSources(item).includes(filters.source))
      && (filters.importance === 'all' || item.importance === filters.importance)
      && (filters.keyword === 'all' || (item.relevanceVersion === undefined ? item.ruleIds.includes(filters.keyword) : directAssessments(item,filters.keyword).length>0))
      && occurred !== null && occurred <= now && occurred >= now - rangeHours[filters.timeRange] * 3600000
      && (!search || `${item.title} ${item.summary} ${item.tags.join(' ')}`.toLowerCase().includes(search));
  });
  const score = (item: Signal): number => {
    switch (filters.sort) {
      case 'heat': return heatScore(item) ?? -1;
      case 'published': return publishedTime(item, now) ?? -1;
      case 'importance': return item.importance ? importanceRanks[item.importance] : -1;
      case 'discovered': return timestamp(item.firstSeenAt, now) ?? -1;
    }
  };
  return selected.sort((a, b) => score(b) - score(a)
    || (eventTime(b, now) ?? -1) - (eventTime(a, now) ?? -1)
    || (timestamp(b.firstSeenAt, now) ?? -1) - (timestamp(a.firstSeenAt, now) ?? -1)
    || a.id.localeCompare(b.id));
}

// Filter the full collection before choosing popular posts. Other sort controls
// reorder this same shortlist instead of replacing it with low-engagement posts.
export function selectTopSignals(signals: Signal[], filters: FeedFilters, now = Date.now()): { items: Signal[]; total: number } {
  const ranked=selectSignals(signals,{...filters,sort:'heat'},now);
  const top=ranked.slice(0,FEED_LIMIT);
  return {items:filters.sort==='heat'?top:selectSignals(top,filters,now),total:ranked.length};
}
