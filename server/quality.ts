import type { Candidate, Evidence, Quality, Signal } from '../shared/types.js';
import { canonical } from './parse.js';
import { expiredEvidence, withinWindow } from '../shared/freshness.js';
import { nonTwitterDiscovery, platformOf } from '../shared/discovery.js';
import { qualifiedTwitter, twitterHeat, twitterMetrics } from '../shared/twitter.js';
import { metadataFields } from '../shared/engagement.js';

export const QUALITY_VERSION = 2;
export function routineContent(title: string, eventType = ''): boolean {
  return /客户案例|客户故事|官网入口|镜像指南|访问指南|入门教程|品牌设计|customer stor(?:y|ies)|case stud(?:y|ies)|customer.case|tutorial|marketing/i.test(`${title} ${eventType}`);
}
export function discoveryCandidate(item: Evidence, now = Date.now()): boolean {
  return item.quality?.decision === 'eligible' && withinWindow(item.publishedAt, now) && (qualifiedTwitter(item) || nonTwitterDiscovery(item,now));
}

// Shared hosting is trusted only within the publisher's namespace.
export function officialUrl(raw: string): boolean {
  try {
    const url = new URL(raw); const host = url.hostname.replace(/^www\./, '');
    if (['openai.com', 'anthropic.com', 'blog.google', 'deepmind.google', 'cursor.com', 'code.visualstudio.com', 'qwen.ai', 'qwenlm.github.io', 'api-docs.deepseek.com'].includes(host)) return true;
    if (host === 'huggingface.co') return /^\/blog\/(?!community(?:\/|$))[^/]+\/?$/.test(url.pathname) || /^\/(Qwen|deepseek-ai)\//.test(url.pathname);
    return host === 'github.com' && /^\/(QwenLM|deepseek-ai)\/[^/]+\/(releases|blob|commit)(\/|$)/.test(url.pathname);
  } catch { return false; }
}

export function linkedUrls(item: Evidence): string[] {
  const raw = [...(item.outboundUrls || []), ...(item.text.match(/https?:\/\/[^\s<>"\]]+/g) || [])];
  return [...new Set(raw.flatMap(value => { try { const url = canonical(value.replace(/[.,;!，。；！）)]+$/, '')); const host = new URL(url).hostname; return /(^|\.)(x\.com|twitter\.com|t\.co)$/.test(host) ? [] : [url]; } catch { return []; } }))].slice(0, 3);
}

export function assess(item: Evidence, context: Evidence[] = [], now = Date.now()): Quality {
  const verdict = (decision: Quality['decision'], reason: string): Quality => ({ version: QUALITY_VERSION, decision, reason });
  if(expiredEvidence(item,now)) return verdict('filtered','超过 5 天，自动排除并停止重试');
  // News value depends on the requested scope; an explicitly requested tutorial
  // or creator upload must reach per-rule review instead of being discarded here.
  if (item.sourceKind !== 'x') {
    const target=new URL(item.finalUrl);
    const redirect=/(^|\.)(sogou|baidu)\.com$/.test(target.hostname) && target.pathname === '/link';
    if(item.searchSites?.length && !redirect && !item.searchSites.some(site=>{const expected=new URL('https://'+site);return (target.hostname===expected.hostname || target.hostname.endsWith('.'+expected.hostname)) && target.pathname.startsWith(expected.pathname);})) return verdict('filtered','定向搜索结果不属于指定平台，已排除');
    if(item.contentKind === 'article' && !item.publishedAt && !item.official && new URL(item.finalUrl).pathname === '/') return verdict('filtered','搜索命中导航或聚合首页，未发现有时间依据的发布正文');
    return verdict('eligible', '网页或发布源候选，继续读取原文核验');
  }
  if (item.postType === 'reply') return verdict('filtered','回复推文全部排除，包括官方或原作者补充');
  if (item.postType === 'quote') return verdict('filtered','引用推文已排除，仅保留纯原创');
  if (item.postType === 'repost') return verdict('filtered','纯转发已排除，仅保留纯原创');
  if (item.postType !== 'original') return verdict('filtered','回复类型未知，保留审计等待补查，不视为原创');
  if (!withinWindow(item.publishedAt,now)) return verdict('filtered','推文缺少有效的近 5 天发布时间');
  const metrics=twitterMetrics(item);
  if (!metrics.passed) return verdict('filtered',metrics.reason+'；5 天内等待指标回查');
  if (item.official) return verdict('eligible','已核验发布者的纯原创，四项指标均达标');
  if (linkedUrls(item).length) return verdict('eligible', '原创包含可追溯链接，须读取原文后核验');
  const text=item.text.replace(/https?:\/\/\S+|@\w+/g,' ').trim();
  const substantive=text.length >= 24 && /releas|launch|introduc|announc|ship|now available|new (?:model|version|feature)|benchmark|controlled test|integrat|measur(?:ed|ing)|unsupported.operation|latency|security test|executable code|regression|outage|unavailable|pricing|price reduction|vulnerabilit|acquir|funding|发布|上线|开源|更新|新增|推出|开放|实测|评测|基准|漏洞|收购|融资|版本|降价|故障|回归|中断/i.test(text);
  return substantive ? verdict('eligible','有实质变化描述的原创线索，可无外链；须审核新颖性并标明待核实') : verdict('filtered','缺少具体事件或新增事实，不把闲聊当热点');
}

export function applyQuality(item: Evidence, context: Evidence[] = [], now = Date.now()): Evidence {
  const official = item.sourceKind === 'x' ? item.official : item.official && officialUrl(item.finalUrl);
  const socialDescription=item.sourceKind !== 'x' && item.original && platformOf(item) === 'bilibili';
  const normalized = { ...item, official, ...(socialDescription ? {contentKind:'description' as const} : {}), ...(item.sourceKind === 'x' ? {postType:item.postType || 'unknown' as const,original:item.postType === 'original' && item.original} : {}) };
  const quality = assess(normalized, context,now);
  return { ...normalized, quality, supportingOnly: quality.decision === 'context' };
}

export function evidenceKey(item: Evidence): string {
  if (item.sourceKind === 'x') return `x:${item.externalId}`;
  try { const url = new URL(canonical(item.finalUrl)); url.hostname = url.hostname.replace(/^www\./, ''); url.pathname = url.pathname.replace(/\/$/, '') || '/'; return url.href; } catch { return item.id; }
}

export function mergeEvidence(items: Evidence[]): Evidence[] {
  const values = new Map<string, Evidence>();
  for (const item of items) {
    const key = evidenceKey(item); const old = values.get(key);
    const discoveredBy = [...new Set([...(old?.discoveredBy || (old ? [old.sourceId] : [])), ...(item.discoveredBy || [item.sourceId])])];
    const best = !old || Number(item.original) > Number(old.original) || item.original === old.original && item.text.length > old.text.length ? item : old;
    const observed = [old,item].filter((value):value is Evidence=>!!value && value.original).sort((a,b)=>Date.parse(a.metricsCheckedAt || a.fetchedAt)-Date.parse(b.metricsCheckedAt || b.fetchedAt));
    const metadata = observed.reduce<Partial<Evidence>>((fields,value)=>({...fields,...metadataFields(value)}),{});
    const latest = observed.at(-1);
    if(latest?.sourceKind==='x') Object.assign(metadata,{likes:latest.likes,reposts:latest.reposts,views:latest.views,authorFollowers:latest.authorFollowers,metricsUnavailable:latest.metricsUnavailable});
    const discovered = [old?.firstDiscoveredAt, old?.fetchedAt, item.firstDiscoveredAt, item.fetchedAt].filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
    values.set(key, { ...best, ...metadata, discoveredBy, discoveryRules:{...old?.discoveryRules,...item.discoveryRules}, ...(discovered.length ? { firstDiscoveredAt: new Date(Math.min(...discovered.map(Date.parse))).toISOString() } : {}) });
  }
  return [...values.values()];
}

export function bindVideoEvidence(items:Evidence[]):Evidence[] {
  const others=items.filter(item=>!(platformOf(item)==='bilibili' && item.contentKind==='description'));
  if(!others.length)return items;
  const references=new Set(others.flatMap(linkedUrls).map(url=>evidenceKey({...others[0],sourceKind:'web',finalUrl:url})));
  // A shared author or model name does not establish that a post refers to this video.
  return items.filter(item=>platformOf(item)!=='bilibili' || item.contentKind!=='description' || references.has(evidenceKey(item)));
}

export function selectCandidates(items: Candidate[], limit: number, now = Date.now()): Candidate[] {
  const eligible=mergeEvidence(items.filter(item=>discoveryCandidate(item,now))) as Candidate[];
  const compare=(a:Candidate,b:Candidate)=>Number(b.official)-Number(a.official) || Math.floor(Date.parse(b.publishedAt!)/3600000)-Math.floor(Date.parse(a.publishedAt!)/3600000) || twitterHeat(b)-twitterHeat(a);
  const x=eligible.filter(item=>item.sourceKind === 'x').sort(compare);
  const buckets=new Map<string,Candidate[]>();
  for(const item of eligible.filter(item=>item.sourceKind!=='x').sort(compare)){const key=platformOf(item);const bucket=buckets.get(key)||[];bucket.push(item);buckets.set(key,bucket);}
  const other:Candidate[]=[];
  while([...buckets.values()].some(bucket=>bucket.length))for(const key of ['bilibili','weibo','web','rss']){const item=buckets.get(key)?.shift();if(item)other.push(item);}
  let otherCount=Math.min(other.length,limit>1?Math.max(1,Math.round(limit*0.3)):0);
  let xCount=Math.min(x.length,limit-otherCount);
  otherCount=Math.min(other.length,limit-xCount);
  xCount=Math.min(x.length,limit-otherCount);
  const selected:Candidate[]=[];let xi=0,oi=0;const total=xCount+otherCount;
  while(selected.length<total){const expectedOther=Math.round((selected.length+1)*otherCount/total);if(oi<otherCount && (oi<expectedOther || xi>=xCount))selected.push(other[oi++]);else selected.push(x[xi++]);}
  return selected;
}

export function reviewHistorical(signal: Signal, context: Evidence[]): Signal {
  const evidence = signal.evidence.map(item => applyQuality(item, context));
  const usable = evidence.filter(item => item.quality?.decision === 'eligible');
  const lostOfficial = signal.status === 'confirmed' && !usable.some(item => item.official) && signal.evidence.some(item => item.official);
  const routine=routineContent(signal.title,signal.eventType);
  const needsReview=signal.screeningVersion !== QUALITY_VERSION;
  return { ...signal, evidence, auditOnly: !usable.length || routine || needsReview, auditReason:routine ? '普通客户案例、教程或营销内容不作为热点' : needsReview ? '待按新版热点与新颖性规则重新核验' : signal.auditReason, ...(lostOfficial ? { status: 'pending' as const, reason: `${signal.reason}；来源身份规则更新，需重新核验。` } : {}) };
}
