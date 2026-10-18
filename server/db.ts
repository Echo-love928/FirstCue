import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, defaults } from './config.js';
import type { Candidate, Settings, Signal, Source } from '../shared/types.js';
import { applyQuality, bindVideoEvidence, QUALITY_VERSION, reviewHistorical } from './quality.js';
import { nonTwitterDiscovery } from '../shared/discovery.js';
import { FRESHNESS_HOURS } from '../shared/freshness.js';
import { expireContent } from './retention.js';
import { TWITTER_FILTER_VERSION } from '../shared/twitter.js';
import { syncEvidenceMetadata, syncTwitterEvents } from './twitter-policy.js';
import { normalizeMetadata } from '../shared/engagement.js';
import { migrateRelevance } from './relevance-migration.js';
export class Store {
  db: DatabaseSync;
  constructor(filename = path.join(config.dataDir, 'signal.sqlite')) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    const initialize = () => this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS objects (space TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(space,id));
      CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL,kind TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(day,kind));
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);`);
    const until = Date.now() + 5000;
    for (;;) { try { initialize(); break; } catch (error) { if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= until) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } }
    this.transaction(() => {
      const saved = this.get<Settings>('state', 'settings');
      if (!saved) this.put('state', 'settings', defaults);
      else if (!saved.model && defaults.model || !saved.recipient && defaults.recipient) this.put('state', 'settings', { ...saved, model: saved.model || defaults.model, recipient: saved.recipient || defaults.recipient });
      if (!this.get('state', 'initialized')) {
        const sources: Source[] = [
          { id: 'bing', name: 'Bing 网页搜索', kind: 'web', url: 'https://www.bing.com/search', enabled: true, official: false },
          { id: 'duckduckgo', name: 'DuckDuckGo · 备选', kind: 'web', url: 'https://html.duckduckgo.com/html/', enabled: false, official: false },
          { id: 'twitter', name: 'X / TwitterAPI.io', kind: 'x', url: 'https://api.twitterapi.io', enabled: true, official: false },
          { id: 'openai', name: 'OpenAI News', kind: 'rss', url: 'https://openai.com/news/rss.xml', enabled: true, official: true },
          { id: 'google', name: 'Google AI Blog', kind: 'rss', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', enabled: true, official: true },
        ];
        sources.forEach(source => this.put('sources', source.id, source)); this.put('state', 'initialized', true);
      }
      if (!this.get('state', 'huggingfaceSourceAdded')) {
        this.put('sources', 'huggingface', { id: 'huggingface', name: 'Hugging Face Blog', kind: 'rss', url: 'https://huggingface.co/blog/feed.xml', enabled: true, official: true });
        this.put('state', 'huggingfaceSourceAdded', true);
      }
      if (!this.get('state', 'qualitySourcesV1')) {
        const additions: Source[] = [
          {id:'baidu',name:'百度网页搜索',kind:'web',url:'https://m.baidu.com/s',enabled:false,official:false},
          {id:'sogou',name:'搜狗网页搜索',kind:'web',url:'https://www.sogou.com/web',enabled:true,official:false},
          {id:'brave',name:'Brave Search · 备选',kind:'web',url:'https://search.brave.com/search',enabled:false,official:false},
          {id:'anthropic',name:'Anthropic News',kind:'rss',format:'page',url:'https://www.anthropic.com/news',enabled:true,official:true},
          {id:'cursor',name:'Cursor Changelog',kind:'rss',url:'https://cursor.com/changelog/rss.xml',enabled:true,official:true},
          {id:'vscode',name:'VS Code Updates',kind:'rss',url:'https://code.visualstudio.com/feed.xml',enabled:true,official:true},
          {id:'qwen',name:'Qwen 官方博客',kind:'rss',format:'page',url:'https://qwenlm.github.io/',enabled:true,official:true},
          {id:'deepseek',name:'DeepSeek 官方更新',kind:'rss',format:'page',url:'https://api-docs.deepseek.com/',enabled:true,official:true},
        ];
        for(const source of additions) if(!this.get('sources',source.id)) this.put('sources',source.id,source);
        this.put('state','qualitySourcesV1',true);
      }
      if (this.get<number>('state','qualityVersion') !== QUALITY_VERSION) {
        const context=this.list<Candidate>('candidates');
        for(const item of context) {
          const value=applyQuality(item,context);
          this.put('candidates',item.id,{...item,...value,processedHash:value.quality?.decision === 'filtered' ? value.contentHash : null,attempts:0});
        }
        for(const signal of this.list<Signal>('events')) { if(!this.get('event-audit-v2',signal.id)) this.put('event-audit-v2',signal.id,signal); this.put('events',signal.id,reviewHistorical(signal,context)); }
        this.put('state','settings',{...this.settings(),lookbackHours:FRESHNESS_HOURS});
        this.put('state','qualityVersion',QUALITY_VERSION);
      }
      if(this.get<number>('state','twitterFilterVersion')!==TWITTER_FILTER_VERSION) {
        for(const item of this.list<Candidate>('candidates').filter(item=>item.sourceKind === 'x')) {
          if(!this.get('twitter-filter-audit-v1',item.id))this.put('twitter-filter-audit-v1',item.id,item);
          const value=applyQuality(item);this.put('candidates',item.id,{...item,...value,processedHash:value.quality?.decision === 'filtered' ? item.contentHash : item.processedHash});
        }
        for(const signal of this.list<Signal>('events').filter(item=>item.evidence.some(ev=>ev.sourceKind === 'x')))if(!this.get('twitter-event-audit-v1',signal.id))this.put('twitter-event-audit-v1',signal.id,signal);
        syncTwitterEvents(this);this.put('state','twitterFilterVersion',TWITTER_FILTER_VERSION);
      }
      if(!this.get('state','multiPlatformDiscoveryV1')) {
        for(const source of [
          {id:'bilibili',name:'B站公开视频',kind:'web',format:'bilibili',url:'https://api.bilibili.com/x/web-interface/search/all/v2',enabled:true,official:false},
          {id:'weibo',name:'微博公开内容',kind:'web',format:'weibo',url:'https://weibo.com/',enabled:true,official:false}
        ] satisfies Source[])if(!this.get('sources',source.id))this.put('sources',source.id,source);
        for(const item of this.list<Candidate>('candidates').filter(item=>item.sourceKind==='web')) {
          if(!this.get('multiplatform-audit-v1',item.id))this.put('multiplatform-audit-v1',item.id,item);
          const value=applyQuality(item);this.put('candidates',item.id,{...item,...value,...(nonTwitterDiscovery(value)?{processedHash:null,attempts:0}:{})});
        }
        this.put('state','multiPlatformDiscoveryV1',true);
      }
      if(!this.get('state','videoIntroBindingV1')) {
        for(const signal of this.list<Signal>('events')) {
          const evidence=bindVideoEvidence(signal.evidence);
          if(evidence.length===signal.evidence.length)continue;
          this.put('video-binding-audit-v1',signal.id,signal);this.put('events',signal.id,{...signal,evidence});
        }
        this.put('state','videoIntroBindingV1',true);
      }
      if(!this.get('state','engagementMetadataV1')) {
        for(const item of this.list<Candidate>('candidates')) this.put('candidates',item.id,normalizeMetadata(item));
        for(const event of this.list<Signal>('events')) this.put('events',event.id,{...event,evidence:event.evidence.map(normalizeMetadata)});
        syncEvidenceMetadata(this);
        this.put('state','engagementMetadataV1',true);
      }
      migrateRelevance(this);
    });
    expireContent(this);
  }
  get<T>(space: string, id: string): T | null { const row = this.db.prepare('SELECT data FROM objects WHERE space=? AND id=?').get(space, id); return row ? JSON.parse(row.data as string) as T : null; }
  list<T>(space: string): T[] { return this.db.prepare('SELECT data FROM objects WHERE space=? ORDER BY updated DESC').all(space).map(row => JSON.parse(row.data as string) as T); }
  put(space: string, id: string, value: unknown): void { this.db.prepare('INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(space,id) DO UPDATE SET data=excluded.data,updated=excluded.updated').run(space, id, JSON.stringify(value), Date.now()); }
  remove(space: string, id: string): void { this.db.prepare('DELETE FROM objects WHERE space=? AND id=?').run(space, id); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  settings(): Settings { return {...defaults,...this.get<Settings>('state', 'settings'),lookbackHours:FRESHNESS_HOURS}; }
  day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  usage(): Record<string, number> { return Object.fromEntries(this.db.prepare('SELECT kind,used FROM usage WHERE day=?').all(this.day()).map(row => [row.kind, row.used])); }
  reserve(kind: string, amount: number, limit: number): boolean { return this.transaction(() => { const used = Number(this.db.prepare('SELECT used FROM usage WHERE day=? AND kind=?').get(this.day(), kind)?.used || 0); if (used + amount > limit) return false; this.db.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(day,kind) DO UPDATE SET used=excluded.used').run(this.day(), kind, used + amount); return true; }); }
  lease(name: string, owner: string, ttl: number): boolean { return this.transaction(() => { const old = this.db.prepare('SELECT * FROM leases WHERE name=?').get(name); if (old && Number(old.expires) > Date.now() && old.owner !== owner) return false; this.db.prepare('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(name, owner, Date.now() + ttl); return true; }); }
  release(name: string, owner: string): void { this.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(name, owner); }
  close(): void { this.db.close(); }
}
