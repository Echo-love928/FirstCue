import { load } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import type { Evidence, Source } from '../shared/types.js';
import { publicUrl } from './http.js';
import { officialUrl } from './quality.js';
import { publication } from './publication.js';
import { metadataFields, normalizeMetadata } from '../shared/engagement.js';
import { sourceMetadata } from './metadata.js';
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const isoDate = (value: unknown): string | null => { if (typeof value !== 'string' || !value.trim()) return null; const d = new Date(value); return Number.isFinite(d.getTime()) && d.getTime() <= Date.now() + 300000 ? d.toISOString() : null; };
export function canonical(raw: string): string { const url = publicUrl(raw); url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|spm_id_from|vd_source)/i.test(key)) url.searchParams.delete(key); url.searchParams.sort(); return url.href; }
export function makeEvidence(source: Source, raw: Partial<Evidence> & { url: string; title: string; text: string }): Evidence {
  const url = canonical(raw.url); const text = raw.text.replace(/\s+/g, ' ').trim().slice(0, 9000);
  return normalizeMetadata({ id: hash(`${source.id}:${raw.externalId || url}`), sourceId: source.id, sourceKind: source.kind, contentKind: source.kind === 'rss' ? 'feed' : source.kind === 'x' ? 'post' : 'snippet', externalId: raw.externalId || url, finalUrl: url, publishedAt: null, fetchedAt: new Date().toISOString(), author: new URL(url).hostname, official: false, original: false, discoveredBy: [source.id], ...raw, url, title: raw.title.slice(0, 240), text, contentHash: hash(`${raw.title}|${text}`) });
}
export function searchLink(raw: string, base: string): string {
  const url = new URL(raw, base);
  if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname === '/ck/a') { const u = url.searchParams.get('u'); if (u?.startsWith('a1')) return canonical(Buffer.from(u.slice(2), 'base64url').toString('utf8')); }
  if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.searchParams.has('uddg')) return canonical(url.searchParams.get('uddg')!);
  return canonical(url.href);
}
export function searchRedirect(html: string, base: string): string | null {
  const url=new URL(base);
  if(!/(^|\.)(sogou|baidu)\.com$/.test(url.hostname) || url.pathname !== '/link') return null;
  // Read a literal target only. Never execute search-page JavaScript.
  const match=html.match(/window\.location\.replace\(\s*("(?:[^"\\]|\\.)*")\s*\)/);
  if(match) return canonical(JSON.parse(match[1]));
  return null;
}
export function parseSearch(html: string, source: Source, base: string): Evidence[] {
  const $ = load(html); const pageText = $('body').text();
  if (/verify (?:you are|you're) human|unusual traffic|captcha|anomaly\.js|b_captcha|验证您是|异常流量|安全验证|访问过于频繁|访问验证/i.test(pageText + html.slice(0, 10000))) throw new Error('搜索页出现验证码或访问校验，本轮停止该来源');
  const selectors: Record<string, { entry: string; link: string; snippet: string }> = {
    bing: { entry: '.b_algo', link: 'h2 a', snippet: '.b_caption p' },
    duckduckgo: { entry: '.result, tr:has(.result-link)', link: '.result__a, .result-link', snippet: '.result__snippet, .result-snippet' },
    baidu: { entry: '#content_left .result, #content_left .c-container, .c-result', link: 'h3 a, h3', snippet: '.c-abstract, .c-span-last, .cosc-summary, [data-module="abstract"]' },
    brave: { entry: '.snippet[data-type="web"], .snippet', link: 'a.heading-serpresult, a[href]:has(.title)', snippet: '.snippet-description, .content' },
    sogou: { entry: '.vrwrap, .rb', link: 'h3 a', snippet: '.star-wiki, .str_info, .str-text-info, .txt-info, .ft' },
  };
  const selector = selectors[source.id]; if (!selector) throw new Error('未配置此搜索引擎的解析器');
  const entries = $(selector.entry);
  const result: Evidence[] = [];
  entries.each((_, el) => { const node = $(el); if (node.find('[data-ad], .ad-label').length || /^(广告|赞助|Sponsored)$/.test(node.find('.ad, .ad-label').text().trim())) return; const link = node.find(selector.link).first(); const title = link.text().trim(); let href = link.attr('href');
    if(source.id === 'baidu') { try { href=JSON.parse(node.attr('data-log') || '{}').mu || href; } catch { /* Desktop cards can omit data-log. */ } }
    if (!title || !href) return; try { const url = searchLink(href, base); const host = new URL(url).hostname; if (/(^|\.)(bing|duckduckgo|brave|sogou)\.com$/.test(host) && !/\/link\?/.test(url)) return; if (/(^|\.)baidu\.com$/.test(host) && !/^(baike|baijiahao)\./.test(host) && !/\/link\?/.test(url)) return; if (!result.some(item => item.url === url)) result.push(makeEvidence(source, { url, title, text: node.find(selector.snippet).text() || title })); } catch { /* Invalid/private targets are excluded. */ } });
  if (!result.length && !/no results|did not match|没有找到|未找到相关|找不到.*结果/i.test(pageText)) throw new Error('无法识别搜索结果结构，未将此响应视为零结果');
  return result.slice(0, 20);
}
export function article(html:string,url:string): Partial<Evidence> & {title:string;text:string;publishedAt:string|null;outboundUrls:string[];descriptionOnly?:boolean;contentKind:'article'|'post'|'description'} {
  const $=load(html);const info=publication(html,url);
  const title=$('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text();
  $('script,style,nav,footer,header,aside,form,noscript').remove();
  const main=$('article').first().length?$('article').first():$('main').first().length?$('main').first():$('body');
  const descriptionOnly=info.video || !!info.description;
  const raw=(info.text || info.description || main.text()).replace(/\s+/g,' ').trim().slice(0,9000);
  if(raw.length<(info.video || info.post?40:80) || /checking your browser|verify you are human|just a moment|enable javascript and cookies|登录后查看|请先登录|新浪通行证/i.test(raw.slice(0,800)))throw new Error('原文不可读取：'+new URL(url).hostname);
  const outboundUrls=main.find('a[href]').toArray().flatMap(el=>{try{return[canonical(new URL($(el).attr('href')!,url).href)];}catch{return[];}});
  return {...metadataFields(info),title:title.trim().slice(0,240),text:descriptionOnly?'[仅取得平台简介，未读取视频、字幕或完整帖子] '+raw.slice(0,1500):raw,publishedAt:isoDate(info.date),outboundUrls:[...new Set(outboundUrls)].slice(0,20),descriptionOnly,contentKind:descriptionOnly?'description':info.post?'post':'article',author:info.author};
}
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const str = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' ? str((value as Record<string, unknown>)['#text']) : '';
export function parseFeed(xml: string, source: Source): Evidence[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('订阅包含不支持的外部实体声明');
  if (XMLValidator.validate(xml) !== true) throw new Error('订阅不是有效 XML');
  const data = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(xml);
  const atom = !!data.feed; const items = atom ? list<Record<string, unknown>>(data.feed.entry) : list<Record<string, unknown>>(data.rss?.channel?.item);
  if (!data.feed && !data.rss?.channel) throw new Error('响应不是 RSS 或 Atom 订阅');
  return items.flatMap(item => { try {
    const link = atom ? list<Record<string, string>>(item.link as Record<string, string>[]).find(v => !v['@_rel'] || v['@_rel'] === 'alternate')?.['@_href'] || '' : str(item.link);
    const rawBody = str(item['content:encoded']) || str(item.content) || str(item.description) || str(item.summary); const body = load(rawBody).text();
    const rawDate=str(item.pubDate) || str(item.published) || str(item['dc:date']);
    const updatedAt=isoDate(str(item.updated));
    if ([rawDate,str(item.updated)].some(value=>value && Date.parse(value)>Date.now()+300000)) return [];
    const publishedAt = isoDate(rawDate);
    const url = canonical(link); const official = source.official && officialUrl(url) && new URL(url).hostname === new URL(source.url).hostname;
    const author=str(item['dc:creator']) || str(item.author) || new URL(url).hostname;
    const hn=source.id==='hackernews' || new URL(source.url).hostname==='hnrss.org' || new URL(url).hostname==='news.ycombinator.com';
    return [makeEvidence(source, { url, title: str(item.title), text: body || str(item.title), externalId: str(item.guid) || str(item.id) || url, publishedAt, updatedAt, official, original: body.length >= 80, author,...(hn?sourceMetadata('hackernews',{...item,by:author}):{}) })];
  } catch { return []; } }).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}

export function parseListing(html: string, source: Source, base: string): Evidence[] {
  const $ = load(html); const result: Evidence[] = [];
  if (/verify you are human|checking your browser|just a moment|captcha/i.test($('body').text().slice(0,1500))) throw new Error('发布页出现访问校验');
  $('main a[href], article a[href], aside a[href]').each((_,el) => {
    try {
      const node = $(el); const url = canonical(new URL(node.attr('href')!, base).href); const path = new URL(url).pathname;
      if (!officialUrl(url) || new URL(url).hostname !== new URL(base).hostname || !/^\/(news|changelog|updates|blog)\/[^/]+/.test(path)) return;
      const card=node.closest('article');
      const title = node.find('h2,h3,h4').first().text().trim() || node.text().replace(/\s+/g,' ').trim() || card.find('h2,h3').first().text().trim();
      if (title.length < 8 || result.some(item=>item.url === url)) return;
      const explicitDate=node.find('time[datetime]').attr('datetime') || node.find('time').text() || card.find('.entry-footer span').first().text() || title.match(/\d{4}\/\d{2}\/\d{2}/)?.[0];
      result.push(makeEvidence(source, {url,title,text:title,contentKind:'snippet',official:true,publishedAt:isoDate(explicitDate)}));
    } catch { /* Ignore navigation and non-public links. */ }
  });
  if (!result.length) throw new Error('无法识别官方发布页结构，不作为零结果');
  return result.slice(0, 10);
}
