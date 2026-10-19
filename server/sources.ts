import { z } from 'zod';
import { load } from 'cheerio';
import type { Account, Candidate, Evidence, Signal, Source, SourceResult } from '../shared/types.js';
import { Store } from './db.js';
import { config, safeError } from './config.js';
import { checkHttp, type HttpClient } from './http.js';
import { article, hash, isoDate, makeEvidence, parseFeed, parseListing, parseSearch, searchRedirect } from './parse.js';
import { applyQuality, linkedUrls, officialUrl } from './quality.js';
import { FRESHNESS_MS, withinWindow } from '../shared/freshness.js';
import { TWITTER_METRICS_INTERVAL, twitterMetrics } from '../shared/twitter.js';
import { twitterFields } from './twitter-policy.js';
import { nonTwitterDiscovery, platformOf } from '../shared/discovery.js';
import { metadataFields, normalizeMetadata } from '../shared/engagement.js';
import { sourceMetadata } from './metadata.js';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class Throttle { private last = new Map<string, number>(); async wait(key: string, ms: number): Promise<void> { const now=Date.now();const at=Math.max(now,(this.last.get(key)||0)+ms);this.last.set(key,at);if(at>now)await sleep(at-now); } }
const rawCount = z.unknown().optional();
const tweetSchema = z.object({ id: z.string(), url: z.string(), text: z.string(), createdAt: z.string(), author: z.object({ id: z.string(), userName: z.string(), name:z.string().nullish(),profilePicture:z.string().nullish(),followers:rawCount,isBlueVerified:z.boolean().nullish() }), likeCount: rawCount, replyCount: rawCount, retweetCount: rawCount, viewCount: rawCount, bookmarkCount:rawCount, isReply: z.boolean().nullish(), inReplyToId: z.string().nullish(), inReplyToUserId: z.string().nullish(), conversationId: z.string().nullish(), retweeted_tweet: z.unknown().optional(), quoted_tweet: z.unknown().optional(), entities: z.object({urls:z.array(z.object({expanded_url:z.string().optional(),url:z.string().optional()})).optional()}).nullish() }).passthrough();
const pageSchema = z.object({ tweets: z.array(tweetSchema), has_next_page: z.boolean(), next_cursor: z.string().nullish(), status: z.string().optional(), message: z.string().optional() });
export interface Checkpoint { since: number; until?: number; cursor?: string; }
export interface Collected { items: Evidence[]; result: SourceResult; }
export function ingest(store: Store, item: Evidence): void {
  const old = store.get<Candidate>('candidates', item.id);
  const incoming = normalizeMetadata(item);
  item = normalizeMetadata({ ...item, ...metadataFields(old || {}), ...metadataFields(item), firstDiscoveredAt: old?.firstDiscoveredAt || old?.fetchedAt || item.firstDiscoveredAt || item.fetchedAt });
  item.discoveryRules={...old?.discoveryRules,...item.discoveryRules};
  if(old?.original&&!item.original&&item.sourceKind!=='x'&&old.finalUrl===item.finalUrl){
    item={...item,...old,...metadataFields(item),fetchedAt:item.fetchedAt,discoveryRules:item.discoveryRules,discoveredBy:[...new Set([...(old.discoveredBy||[old.sourceId]),...(item.discoveredBy||[item.sourceId])])]};
  }
  // A fresh X response must still fail the existing thresholds if required
  // metrics disappeared; optional author fields can retain their last value.
  if (item.sourceKind === 'x') for (const key of ['likes', 'reposts', 'views', 'authorFollowers'] as const) item[key] = incoming[key];
  if (old && old.collectedHash === item.contentHash && !(item.sourceKind!=='x'&&item.original&&!old.original)) {
    const metadataChanged=old.postType !== item.postType || JSON.stringify(old.outboundUrls) !== JSON.stringify(item.outboundUrls);
    const recovered=item.sourceKind === 'x' && old.quality?.decision === 'filtered' && item.quality?.decision === 'eligible' && (metadataChanged || !twitterMetrics(old).passed);
    store.put('candidates', item.id, { ...old, ...metadataFields(item), discoveryRules:item.discoveryRules, firstDiscoveredAt: item.firstDiscoveredAt, ...(item.sourceKind === 'x' ? {...twitterFields(item),quality:item.quality,...(item.quality?.decision === 'filtered' ? {processedHash:old.contentHash} : {})} : {}), postType: item.postType || old.postType, inReplyToId: item.inReplyToId, inReplyToAuthorId: item.inReplyToAuthorId, conversationId: item.conversationId, outboundUrls: item.outboundUrls || old.outboundUrls, fetchedAt: item.fetchedAt, discoveredBy: [...new Set([...(old.discoveredBy || [old.sourceId]), ...(item.discoveredBy || [item.sourceId])])], ...(recovered ? {original:item.original,quality:item.quality,processedHash:null,attempts:0} : {}) }); return;
  }
  store.put('candidates', item.id, { ...item, collectedHash: item.contentHash, processedHash: old?.processedHash || null, attempts: 0 });
}
export class Collector {
  throttle = new Throttle();
  constructor(public store: Store, public http: HttpClient, public xKey = config.xKey, public timing = true) {}
  async videoDetails(item: Evidence): Promise<Evidence> {
    const bvid = new URL(item.finalUrl).pathname.match(/^\/video\/(BV[A-Za-z0-9]+)\/?$/)?.[1];
    if (!bvid) throw new Error('B站视频链接未包含有效 BV 号');
    const now=Date.now();
    const schema=z.object({bvid:z.literal(bvid),owner:z.object({name:z.string().optional()}).passthrough().optional(),stat:z.object({}).passthrough(),title:z.string().optional(),desc:z.string().optional(),pubdate:z.number().optional()}).passthrough();
    type VideoData=z.infer<typeof schema>;
    let cache=this.store.get<{at:number;data?:VideoData;error?:string}>('video-details',bvid);
    if (!cache || now-cache.at>=TWITTER_METRICS_INTERVAL) {
      try {
        if(this.timing)await this.throttle.wait('bilibili-details',2000);
        const url=new URL('https://api.bilibili.com/x/web-interface/view');url.searchParams.set('bvid',bvid);
        const doc=await this.http.request(url.href,{headers:{Referer:'https://www.bilibili.com/'},maxBytes:1024*1024,timeoutMs:15000});checkHttp(doc);
        const response=z.object({code:z.number(),message:z.string().optional(),data:z.unknown()}).parse(JSON.parse(doc.text));
        if(response.code!==0)throw new Error(`B站视频详情不可用：${response.code} ${response.message||''}`);
        cache={at:Date.now(),data:schema.parse(response.data)};
        this.store.put('video-details',bvid,cache);
      } catch(error) {
        this.store.put('video-details',bvid,{at:Date.now(),error:safeError(error)});
        throw error;
      }
    }
    if(cache.error || !cache.data)throw new Error(cache.error || 'B站视频详情缺失');
    const data=cache.data;const description=load(data.desc||'').text().trim();
    const preserve=item.original && item.contentKind==='description';
    const text=preserve?item.text:description.length>=40?'[B站公开视频简介，未读取视频或字幕] '+description:item.text;
    return applyQuality(normalizeMetadata({...item,...metadataFields(sourceMetadata('bilibili',data)),author:data.owner?.name || item.author,
      ...(preserve?{}:{title:data.title || item.title,text,contentKind:'description' as const,original:description.length>=40,publishedAt:data.pubdate?isoDate(new Date(data.pubdate*1000).toISOString()):item.publishedAt,contentHash:hash(`${data.title || item.title}|${text}`)}),
      firstDiscoveredAt:item.firstDiscoveredAt || item.fetchedAt,fetchedAt:new Date(Math.max(Date.parse(item.fetchedAt)||0,cache.at)).toISOString(),metricsCheckedAt:new Date(cache.at).toISOString(),metricsAttemptedAt:new Date(now).toISOString()}));
  }
  async refreshVideoMetrics(source: Source, limit: number, now=Date.now()): Promise<Collected> {
    const visible=new Set(this.store.list<Signal>('events').flatMap(event=>event.evidence.map(item=>item.finalUrl)));
    const due=this.store.list<Candidate>('candidates').filter(item=>item.sourceId===source.id && platformOf(item)==='bilibili' && item.original && withinWindow(item.publishedAt,now) && now-(Date.parse(item.metricsAttemptedAt||'')||0)>=TWITTER_METRICS_INTERVAL);
    due.sort((a,b)=>Number(visible.has(b.finalUrl))-Number(visible.has(a.finalUrl)) || (Date.parse(a.metricsAttemptedAt||'')||0)-(Date.parse(b.metricsAttemptedAt||'')||0));
    const selected=[...new Map(due.map(item=>[item.finalUrl,item])).values()].slice(0,Math.max(0,Math.min(3,limit)));
    const items:Evidence[]=[];const errors:string[]=[];
    for(const old of selected) {
      this.store.put('candidates',old.id,{...old,metricsAttemptedAt:new Date(now).toISOString()});
      try {const value=await this.videoDetails(old);ingest(this.store,value);items.push(value);}
      catch(error){errors.push(safeError(error));}
    }
    return this.result(source,items,errors.length?items.length?'partial':'failed':items.length?'success':'cached',`视频详情回查 ${items.length}/${selected.length} 条，补齐作者头像与互动；${errors.length?errors.join('；'):'30 分钟内复用详情'}`);
  }
  async web(source: Source, query: string): Promise<Collected> {
    const cacheId = hash(`web-quality-v2:${source.id}:${query}`); const cache = this.store.get<{ expires: number; items: Evidence[] }>('cache', cacheId);
    if (cache && cache.expires > Date.now()) return this.result(source, cache.items.map(item=>applyQuality(item)), 'cached', '复用 30 分钟内结果');
    if (this.timing) await this.throttle.wait(source.id, 5000 + Math.floor(Math.random() * 500));
    const url = new URL(source.url); url.searchParams.set(source.id === 'baidu' ? url.hostname === 'm.baidu.com' ? 'word' : 'wd' : source.id === 'sogou' ? 'query' : 'q', query);
    if (source.id === 'bing') { url.searchParams.set('setlang', 'en'); }
    const doc = await this.http.request(url.href, {maxBytes:source.id === 'baidu' ? 4*1024*1024 : 2*1024*1024}); checkHttp(doc);
    const searchSites=[...query.matchAll(/site:([a-z0-9.-]+(?:\/[^\s)]+)?)/ig)].map(match=>match[1]);
    const items = parseSearch(doc.text, source, doc.url).map(item=>applyQuality({...item,searchSites})); this.store.put('cache', cacheId, { expires: Date.now() + 30 * 60000, items });
    const collected=this.result(source,items); collected.result.query=query; return collected;
  }
  async platformSearch(source:Source,engine:Source,query:string):Promise<Collected> {
    let found:Collected;
    try{found=await this.web(engine,query);}catch(error){throw new Error(`${engine.name}：${safeError(error)}`);}
    const items=found.items.map(item=>({...item,id:hash(`${source.id}:${item.finalUrl}`),sourceId:source.id,discoveredBy:item.discoveredBy || [engine.id]}));
    return this.result(source,items,found.result.status,`经 ${engine.name} 发现公开内容；${found.result.message}`);
  }
  async videoSearch(source:Source,query:string):Promise<Collected> {
    const cacheId=hash(`bilibili-public-v3:${query}`);const cache=this.store.get<{expires:number;items:Evidence[]}>('cache',cacheId);
    if(cache && cache.expires>Date.now())return this.result(source,cache.items.map(item=>applyQuality(item)),'cached','复用 30 分钟内的公开视频简介');
    if(this.timing)await this.throttle.wait(source.id,5000);
    const url=new URL(source.url);const typed=url.pathname.endsWith('/type');
    if(typed){url.searchParams.set('search_type','video');url.searchParams.set('order','pubdate');}
    url.searchParams.set('keyword',query);url.searchParams.set('page','1');
    const doc=await this.http.request(url.href,{maxBytes:3*1024*1024});checkHttp(doc);
    const data=z.object({code:z.number(),message:z.string().optional(),data:z.unknown()}).parse(JSON.parse(doc.text));
    if(data.code!==0)throw new Error(`B站公开搜索不可用：${data.code} ${data.message||''}`);
    const results=z.object({result:z.array(z.unknown())}).parse(data.data).result;
    const rows=typed?results:z.array(z.object({result_type:z.string(),data:z.array(z.unknown()).optional()})).parse(results).find(item=>item.result_type==='video')?.data || [];
    const schema=z.object({bvid:z.string().regex(/^BV[A-Za-z0-9]+$/),title:z.string(),author:z.string(),mid:z.union([z.number(),z.string()]).optional(),description:z.string().optional(),pubdate:z.number()}).passthrough();
    const items=rows.slice(0,20).flatMap(row=>{const parsed=schema.safeParse(row);if(!parsed.success)return[];const item=parsed.data;const text=load(item.description||'').text().trim();return[applyQuality(makeEvidence(source,{url:`https://www.bilibili.com/video/${item.bvid}/`,externalId:item.bvid,title:load(item.title).text(),text:'[B站公开视频简介，未读取视频或字幕] '+text,publishedAt:isoDate(new Date(item.pubdate*1000).toISOString()),author:item.author,contentKind:'description',original:text.length>=40,...sourceMetadata('bilibili',item),metricsCheckedAt:new Date().toISOString()}))];});
    this.store.put('cache',cacheId,{expires:Date.now()+30*60000,items});
    return this.result(source,items,undefined,'公开视频简介与作者、发布时间；保留视频链接，未读取字幕');
  }
  async page(source: Source, since: number): Promise<Collected> {
    const cache = this.store.get<{at:number;items:Evidence[]}>('pages', source.id);
    if (cache && Date.now()-cache.at < 30*60000) return this.result(source, cache.items.filter(item=>!item.publishedAt || Date.parse(item.publishedAt)>=since), 'cached', '复用官方发布页');
    let doc=await this.http.request(source.url); checkHttp(doc);
    if(source.id === 'deepseek' && new URL(doc.url).pathname === '/') {
      const $=load(doc.text); const href=$('a[href^="/news/news"]').first().attr('href');
      if(!href) throw new Error('DeepSeek 官网未找到新闻入口');
      doc=await this.http.request(new URL(href,doc.url).href); checkHttp(doc);
    }
    const items=parseListing(doc.text, source, doc.url); this.store.put('pages',source.id,{at:Date.now(),items});
    return this.result(source,items.filter(item=>!item.publishedAt || Date.parse(item.publishedAt)>=since));
  }
  async rss(source: Source, since: number): Promise<Collected> {
    const old = this.store.get<{ etag?: string; modified?: string; items: Evidence[] }>('feeds', source.id);
    const headers: Record<string, string> = {}; if (old?.etag) headers['If-None-Match'] = old.etag; if (old?.modified) headers['If-Modified-Since'] = old.modified;
    const doc = await this.http.request(source.url, { headers, maxBytes: 3 * 1024 * 1024 });
    const recent = (item:Evidence) => !item.publishedAt || Date.parse(item.publishedAt) >= since;
    if (doc.status === 304 && old) return this.result(source, old.items.filter(recent), 'cached', '订阅未变化');
    checkHttp(doc); const items = parseFeed(doc.text, {...source,url:doc.url}); this.store.put('feeds', source.id, { etag: doc.headers.etag, modified: doc.headers['last-modified'], items: items.slice(0, 100) });
    return this.result(source, items.filter(recent));
  }
  async x(source: Source, query: string, fallbackSince: number, account?: Account): Promise<Collected> {
    if (!this.xKey) return this.result(source, [], 'unconfigured', '填写 TWITTERAPI_IO_KEY 后启用 X 采集');
    const settings = this.store.settings(); const key = hash(`x:quality-v2:${account?.id || query}`); const saved = this.store.get<Checkpoint>('checkpoints', key);
    const cutoff=Math.max(fallbackSince,Date.now()-FRESHNESS_MS);
    // Discard an obsolete cursor window; never spend requests backfilling expired data.
    const resumable=saved?.until && saved.until >= cutoff;
    const checkpoint: Checkpoint = resumable ? saved! : { since: Math.max(cutoff, (saved?.until ? cutoff : saved?.since || cutoff) - 10 * 60000), until: Date.now(), cursor: '' };
    this.store.put('checkpoints', key, checkpoint);
    let cursor = checkpoint.cursor || ''; let complete = false; const items: Evidence[] = []; const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      if (!this.store.reserve('xRequests', 1, settings.xDailyLimit)) return this.result(source, items, 'limited', 'X 每日请求上限已到；窗口保留等待续查');
      if ((this.store.usage().xResults || 0) + 20 > settings.xResultDailyLimit) return this.result(source, items, 'limited', 'X 每日结果预算不足以读取下一页');
      if (this.timing) await this.throttle.wait('twitter', 2000);
      const url = new URL(account ? 'https://api.twitterapi.io/twitter/user/last_tweets' : 'https://api.twitterapi.io/twitter/tweet/advanced_search');
      if (account) { url.searchParams.set(account.userId ? 'userId' : 'userName', account.userId || account.userName); url.searchParams.set('includeReplies', 'false'); }
      else { url.searchParams.set('query', `(${query}) -filter:replies -filter:retweets since_time:${Math.floor(checkpoint.since / 1000)} until_time:${Math.floor(checkpoint.until! / 1000)}`); url.searchParams.set('queryType', 'Latest'); }
      url.searchParams.set('cursor', cursor);
      const doc = await this.http.request(url.href, { headers: { 'X-API-Key': this.xKey } });
      if (doc.status === 400 && cursor) { this.store.put('checkpoints', key, { ...checkpoint, cursor: '' }); throw new Error('X 续查游标失效，已保留窗口，将重新查询去重'); }
      checkHttp(doc); const data = pageSchema.parse(JSON.parse(doc.text));
      if (data.status && data.status !== 'success') throw new Error(`X 业务请求失败：${data.message || data.status}`);
      this.store.reserve('xResults', data.tweets.length, Number.MAX_SAFE_INTEGER);
      for (const tweet of data.tweets) {
        const publishedAt = isoDate(tweet.createdAt); if (publishedAt && Date.parse(publishedAt) < Math.max(cutoff,checkpoint.since)) continue;
        const value=this.fromTweet(source,tweet);
        if (!items.some(item => item.id === value.id)) items.push(value);
      }
      const reachedOld = data.tweets.some(tweet => (isoDate(tweet.createdAt) ? Date.parse(tweet.createdAt) : Infinity) < Math.max(cutoff,checkpoint.since));
      this.store.transaction(() => { for (const item of items) ingest(this.store, item); });
      if (!data.has_next_page || reachedOld) { complete = true; break; }
      if (!data.next_cursor || data.next_cursor === cursor || seen.has(data.next_cursor)) throw new Error('X 分页游标重复或缺失，窗口未标为完成');
      seen.add(data.next_cursor); cursor = data.next_cursor;
      this.store.put('checkpoints', key, { ...checkpoint, cursor });
    }
    this.store.put('checkpoints', key, complete ? { since: checkpoint.until } : { ...checkpoint, cursor });
    return this.result(source, items, complete ? (items.length ? 'success' : 'empty') : 'partial', complete ? '增量窗口采集完成' : '已到单轮分页上限，保留窗口继续补查');
  }
  fromTweet(source:Source,tweet:z.infer<typeof tweetSchema>,now=Date.now()):Evidence {
        const publishedAt=isoDate(tweet.createdAt);
        const official = config.trustedXIds.includes(tweet.author.id);
        const postType = tweet.retweeted_tweet ? 'repost' : tweet.isReply === true || tweet.inReplyToId ? 'reply' : tweet.isReply === false ? tweet.quoted_tweet ? 'quote' : 'original' : 'unknown';
        const outboundUrls = tweet.entities?.urls?.map(link=>link.expanded_url || link.url || '').filter(Boolean);
        return applyQuality(makeEvidence(source, { url: tweet.url, title: tweet.text.slice(0, 100), text: tweet.text, externalId: tweet.id, publishedAt, author: `@${tweet.author.userName}`, authorId: tweet.author.id, official, postType, inReplyToId: tweet.inReplyToId || undefined, inReplyToAuthorId: tweet.inReplyToUserId || undefined, conversationId:tweet.conversationId || undefined, outboundUrls, original: postType === 'original', ...sourceMetadata('x',tweet),authorBlueVerified:tweet.author.isBlueVerified ?? undefined,metricsCheckedAt:new Date(now).toISOString(),metricsAttemptedAt:new Date(now).toISOString(),metricsUnavailable:false }));
  }
  async refreshMetrics(source:Source,now=Date.now(),targetIds?:ReadonlySet<string>):Promise<Collected> {
    if(!this.xKey) return this.result(source,[],'unconfigured','X 指标回查未配置 Key');
    const settings=this.store.settings();
    // Explicit targets support one-time repair of referenced legacy evidence;
    // scheduled refresh still only reads original posts and obeys the interval.
    const due=this.store.list<Candidate>('candidates').filter(item=>item.sourceId === source.id && item.sourceKind === 'x' && withinWindow(item.publishedAt,now) && (targetIds ? targetIds.has(item.externalId) : item.postType === 'original' && now-(Date.parse(item.metricsAttemptedAt || item.metricsCheckedAt || '') || 0) >= TWITTER_METRICS_INTERVAL));
    const knownPass=(item:Candidate)=>twitterMetrics(item).passed;
    due.sort((a,b)=>(Date.parse(a.metricsAttemptedAt || a.metricsCheckedAt || '')||0)-(Date.parse(b.metricsAttemptedAt || b.metricsCheckedAt || '')||0) || Number(knownPass(b))-Number(knownPass(a)) || Date.parse(b.publishedAt!)-Date.parse(a.publishedAt!));
    if(!due.length)return this.result(source,[],'cached','没有到期的原创指标需要回查');
    const remaining=settings.xResultDailyLimit-(this.store.usage().xResults||0);
    if(remaining<1)return this.result(source,[],'limited','X 每日结果预算已到，保留指标回查队列');
    const selected=due.slice(0,Math.min(50,remaining));
    if(!this.store.reserve('xRequests',1,settings.xDailyLimit))return this.result(source,[],'limited','X 每日请求预算已到，保留指标回查队列');
    for(const item of selected)this.store.put('candidates',item.id,{...item,metricsAttemptedAt:new Date(now).toISOString()});
    if(this.timing)await this.throttle.wait('twitter',2000);
    const url=new URL('https://api.twitterapi.io/twitter/tweets');url.searchParams.set('tweet_ids',selected.map(item=>item.externalId).join(','));
    const doc=await this.http.request(url.href,{headers:{'X-API-Key':this.xKey}});checkHttp(doc);
    const data=z.object({tweets:z.array(z.unknown()),status:z.string().optional(),msg:z.string().optional(),message:z.string().optional()}).parse(JSON.parse(doc.text));
    if(data.status && data.status!=='success')throw new Error('X 指标回查失败：'+(data.msg||data.message||data.status));
    if(data.tweets.length>selected.length)throw new Error('X 指标回查返回数量超出请求范围，已拒绝结果');
    if(!this.store.reserve('xResults',data.tweets.length,settings.xResultDailyLimit))throw new Error('X 指标回查超过每日结果预算，已停止处理');
    const byId=new Map(data.tweets.flatMap(raw=>{const parsed=tweetSchema.safeParse(raw);return parsed.success && parsed.data.id ? [[parsed.data.id,parsed.data] as const] : [];}));
    const items=selected.map(old=>{const tweet=byId.get(old.externalId);return tweet ? this.fromTweet(source,tweet,now) : applyQuality({...old,metricsAttemptedAt:new Date(now).toISOString(),metricsUnavailable:true});});
    this.store.transaction(()=>{for(const item of items)ingest(this.store,item);});
    const obtained=items.filter(item=>!item.metricsUnavailable).length;
    return this.result(source,items,obtained<selected.length ? 'partial' : 'success','指标回查 '+obtained+'/'+selected.length+' 条；待回查 '+Math.max(0,due.length-selected.length)+' 条；共用现有 X 预算');
  }
  async resolveAccount(account: Account): Promise<Account> {
    if (account.userId || !this.xKey) return account;
    if (!this.store.reserve('xRequests', 1, this.store.settings().xDailyLimit)) throw new Error('X 每日请求上限已到');
    if (this.timing) await this.throttle.wait('twitter', 2000);
    const url = new URL('https://api.twitterapi.io/twitter/user/info'); url.searchParams.set('userName', account.userName);
    const doc = await this.http.request(url.href, { headers: { 'X-API-Key': this.xKey } }); checkHttp(doc);
    const data = z.object({ status: z.literal('success'), data: z.object({ id: z.string() }) }).parse(JSON.parse(doc.text));
    const resolved = { ...account, userId: data.data.id }; this.store.put('accounts', account.id, resolved); return resolved;
  }
  async enrich(item: Evidence): Promise<Evidence> {
    if(platformOf(item)==='bilibili') {
      try {return await this.videoDetails(item);}
      catch {if(nonTwitterDiscovery(item))return {...item,metricsAttemptedAt:new Date().toISOString()};}
    }
    if (item.sourceKind === 'x' || item.original && item.text.length > 600 && (item.contentKind === 'article' || item.contentKind === 'feed' && item.official)) return item;
    const cache = this.store.get<{ at: number; value: Evidence }>('articles', item.url);
    if (cache && Date.now() - cache.at < 30 * 60000) return { ...cache.value, id: item.id, sourceId: item.sourceId, sourceKind: item.sourceKind, discoveredBy: item.discoveredBy || [item.sourceId], official: officialUrl(cache.value.finalUrl) };
    try {
      let doc = await this.http.request(item.url); checkHttp(doc);
      const redirect=searchRedirect(doc.text,doc.url);
      if(redirect) { doc=await this.http.request(redirect); checkHttp(doc); }
      const body = article(doc.text, doc.url);
      const value = normalizeMetadata({ ...item, ...metadataFields(body), contentKind:body.contentKind,author:body.author || item.author || new URL(doc.url).hostname, finalUrl: doc.url, text: body.text, outboundUrls:body.outboundUrls, title: body.title || item.title, publishedAt: body.publishedAt || item.publishedAt, original: true, official: officialUrl(doc.url), contentHash: hash(body.text),metricsCheckedAt:new Date().toISOString() });
      this.store.put('articles', item.url, { at: Date.now(), value }); return value;
    } catch (error) {
      const feed = item.sourceKind === 'rss' ? this.store.get<{ items: Evidence[] }>('feeds', item.sourceId)?.items.find(value => value.id === item.id) : undefined;
      const obtained = item.sourceKind === 'rss' && (feed?.original ? feed : item.original ? item : undefined);
      if (obtained) return { ...item, contentKind: 'feed', original: true, official: obtained.official, title: obtained.title, publishedAt: obtained.publishedAt, text: `${obtained.text}\n[仅有发布源摘要；文章全文未读取：${safeError(error)}]`, contentHash: obtained.contentHash };
      return { ...item, original: false, text: `${item.text}\n[原文未读取：${safeError(error)}]` };
    }
  }
  async linked(item: Evidence, cached: Evidence[]=[]): Promise<Evidence[]> {
    const urls=linkedUrls(item).sort((a,b)=>Number(officialUrl(b))-Number(officialUrl(a))).slice(0,2);
    return Promise.all(urls.map(async url=>{
      const saved=cached.find(value=>value.original&&(value.url===url||value.finalUrl===url));
      if(saved)return applyQuality(saved);
      const name=item.sourceKind==='x'?'推文引用原文':'候选引用原文';
      const source:Source={id:item.sourceId,name,kind:'web',url,enabled:true,official:false};
      const value=await this.enrich(makeEvidence(source,{url,title:name,text:'待核验的原始链接',discoveredBy:item.discoveredBy || [item.sourceId]}));
      return applyQuality(value);
    }));
  }
  result(source: Source, items: Evidence[], status?: SourceResult['status'], message = ''): Collected {
    items = items.map(normalizeMetadata);
    const filterReasons:Record<string,number>={}; for(const item of items) if(item.quality?.decision === 'filtered') filterReasons[item.quality.reason]=(filterReasons[item.quality.reason]||0)+1;
    return { items, result: { sourceId: source.id, name: source.name, kind: source.kind, status: status || (items.length ? 'success' : 'empty'), count: items.length, message, filtered:Object.values(filterReasons).reduce((a,b)=>a+b,0), filterReasons } };
  }
}
