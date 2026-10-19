import type { Evidence } from './types.js';

export const TWITTER_FILTER_VERSION = 1;
export const TWITTER_MINIMUM = { likes: 5, reposts: 1, views: 200, authorFollowers: 50 } as const;
export const TWITTER_BLUE_WEIGHT = 1.1;
export const TWITTER_METRICS_INTERVAL = 30 * 60000;

export function twitterMetrics(item: Evidence): { passed: boolean; reason: string } {
  if(item.metricsUnavailable) return {passed:false,reason:'回查未返回可读取推文'};
  const missing: string[] = []; const below: string[] = [];
  const labels = { likes: '点赞', reposts: '转发', views: '浏览', authorFollowers: '作者粉丝' };
  for (const key of Object.keys(TWITTER_MINIMUM) as (keyof typeof TWITTER_MINIMUM)[]) {
    const value = item[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) missing.push(labels[key]);
    else if (value < TWITTER_MINIMUM[key]) below.push(`${labels[key]} ${value}<${TWITTER_MINIMUM[key]}`);
  }
  return { passed: !missing.length && !below.length, reason: [missing.length ? `缺少指标：${missing.join('、')}` : '', below.length ? `未达门槛：${below.join('；')}` : ''].filter(Boolean).join('；') };
}

export function qualifiedTwitter(item: Evidence): boolean {
  return item.sourceKind === 'x' && item.postType === 'original' && item.original && twitterMetrics(item).passed && item.quality?.decision === 'eligible';
}

export function twitterHeat(item: Evidence): number {
  return Math.log1p((item.likes || 0) + 2 * (item.reposts || 0) + (item.replies || 0)) * (item.authorBlueVerified === true ? TWITTER_BLUE_WEIGHT : 1);
}
