import type { Rule, Source } from '../shared/types.js';
import { queryVariants, ruleIntent } from '../shared/relevance.js';

export interface DiscoverySearch { platform:'bilibili'|'weibo'|'web'; source:Source; query:string; ruleId:string; }

export function discoverySearches(rules:Rule[],sources:Source[],limit:number,rotation=0,now=Date.now()):DiscoverySearch[] {
  if(!rules.length || limit<1)return [];
  const platforms=['bilibili','weibo','web'] as const;
  const queues=platforms.map(platform=>rules.slice().sort((a,b)=>Number(new RegExp(platform==='bilibili'?'视频|B站|bilibili':platform==='weibo'?'微博|weibo':'$^','i').test(b.query))-Number(new RegExp(platform==='bilibili'?'视频|B站|bilibili':platform==='weibo'?'微博|weibo':'$^','i').test(a.query))));
  const jobs:DiscoverySearch[]=[];const engines=sources.filter(source=>source.enabled&&source.kind==='web'&&!source.format).sort((a,b)=>a.id.localeCompare(b.id));
  const seen=new Set<string>();
  for(let i=0;i<rules.length*6 && jobs.length<limit;i++) {
    const pi=(i+rotation)%3,platform=platforms[pi];const rule=queues[pi][(Math.floor(i/3)+Math.floor(rotation/3))%rules.length];
    const special=sources.find(source=>source.id===platform);if(special && !special.enabled)continue;
    const source=platform==='web'?engines[(i+rotation)%engines.length]:special;
    if(!source)continue;
    const pass=Math.floor(i/(rules.length*3));
    const variants=queryVariants(rule); const base=variants[(pass+Math.floor(rotation/(Math.max(1,rules.length)*3)))%variants.length];
    const month=new Date(now).toISOString().slice(0,7);
    const videoBase=/的视频/.test(rule.query)?rule.query.split(/的视频/)[0].trim():base;
    const date=pass===0?' '+month:'';
    const query=platform==='bilibili'?videoBase:platform==='weibo'?`(site:weibo.com OR site:weibo.cn) ${base}${date}`:`${base}${date}`;
    const key=JSON.stringify([platform,rule.id,query]);if(seen.has(key))continue;seen.add(key);
    jobs.push({platform,source,query,ruleId:rule.id});
  }
  return jobs;
}

export function xQueryFor(rule:Rule, rotation=0):string {
  const variants=queryVariants(rule),base=variants[rotation%variants.length],intent=ruleIntent(rule);
  return ['release','new-model','update'].includes(intent.action) ? `(${base}) (release OR update OR launch OR 发布 OR 更新)` : `(${base})`;
}
