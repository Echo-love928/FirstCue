import type { EngagementMetrics, Evidence } from './types.js';

export const metricKeys = ['likes', 'reposts', 'replies', 'views', 'bookmarks', 'favorites', 'coins', 'danmaku', 'points'] as const;
export type MetricKey = typeof metricKeys[number];
export const metadataKeys = [...metricKeys, 'author', 'authorId', 'authorName', 'authorAvatarUrl', 'authorUrl', 'authorFollowers', 'authorBlueVerified', 'metricsCheckedAt'] as const;

// APIs return numbers, decimal strings, comma-separated counts and compact units.
// Empty, hidden, invalid and negative values must not turn into zero.
export function count(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\s*[kKmMbB万亿]?$/.test(text)) return undefined;
  const match = text.replaceAll(',', '').match(/^(\d+(?:\.\d+)?)\s*([kKmMbB万亿])?$/)!;
  const units: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, '万': 1e4, '亿': 1e8 };
  const result = Number(match[1]) * (units[(match[2] || '').toLowerCase()] || 1);
  return Number.isSafeInteger(Math.round(result)) && result >= 0 && (match[2] || Number.isInteger(result)) ? Math.round(result) : undefined;
}

export function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { const url = new URL(value.startsWith('//') ? `https:${value}` : value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export function normalizeMetadata<T extends Partial<Evidence>>(item: T): T {
  const result = { ...item };
  for (const key of [...metricKeys, 'authorFollowers'] as const) if (key in item) Object.assign(result, { [key]: count(item[key]) });
  for (const key of ['authorAvatarUrl', 'authorUrl'] as const) if (key in item) Object.assign(result, { [key]: mediaUrl(item[key]) });
  return result;
}

// Partial responses may omit previously collected fields. Explicit zero replaces
// the old value; an omitted field does not erase it.
export function metadataFields(item: Partial<Evidence>): Partial<Evidence> {
  const normalized = normalizeMetadata(item);
  return Object.fromEntries(metadataKeys.flatMap(key => normalized[key] !== undefined && normalized[key] !== '' ? [[key, normalized[key]]] : []));
}

export function interactionScore(item: EngagementMetrics & { metricsUnavailable?: boolean }): number | null {
  if (item.metricsUnavailable) return null;
  const values = metricKeys.map(key => count(item[key]));
  if (!values.some(value => value !== undefined)) return null;
  return (count(item.likes) ?? 0) + 2 * (count(item.reposts) ?? 0) + (count(item.replies) ?? 0) + .01 * (count(item.views) ?? 0) + (count(item.points) ?? 0)
    + 2 * (count(item.bookmarks) ?? 0) + 2 * (count(item.favorites) ?? 0) + 2 * (count(item.coins) ?? 0) + (count(item.danmaku) ?? 0);
}

export function metricRows(item: Evidence): { key: MetricKey; label: string; value: number | undefined }[] {
  const video = /(^|\.)bilibili\.com$/.test(new URL(item.finalUrl).hostname);
  const hn = new URL(item.finalUrl).hostname === 'news.ycombinator.com' || item.sourceId === 'hackernews' || count(item.points) !== undefined;
  const keys: MetricKey[] = hn ? ['points', 'replies'] : ['likes', 'reposts', 'replies', 'views'];
  for (const key of ['bookmarks', 'favorites', 'coins', 'danmaku'] as const) if (count(item[key]) !== undefined) keys.push(key);
  const labels: Record<MetricKey, string> = { likes: '点赞', reposts: '转发', replies: '评论', views: video ? '播放' : '浏览', bookmarks: '书签', favorites: '收藏', coins: '投币', danmaku: '弹幕', points: '评分' };
  return keys.map(key => ({ key, label: labels[key], value: item.metricsUnavailable ? undefined : count(item[key]) }));
}

export function formatCount(value: number | undefined): string {
  return value === undefined ? '—' : value >= 1e8 ? `${Number((value / 1e8).toFixed(1))}亿` : value >= 1e4 ? `${Number((value / 1e4).toFixed(1))}万` : value.toLocaleString('zh-CN');
}
