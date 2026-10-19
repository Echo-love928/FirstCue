import type { Candidate, Evidence, Rule, Signal } from '../shared/types.js';
import { includesTarget, normalizeText, ruleFingerprint, ruleIntent } from '../shared/relevance.js';
import { timestamp } from '../shared/freshness.js';
import { TWITTER_MINIMUM } from '../shared/twitter.js';
import { applyQuality, evidenceKey, mergeEvidence } from './quality.js';
import { hash } from './parse.js';

export function discoveryMatches(item:Evidence,rule:Rule):boolean {
  const intent=ruleIntent(rule),text=normalizeText(`${item.title} ${item.text} ${item.author} ${item.authorName||''}`);
  const searched=item.discoveryRules?.[rule.id]===ruleFingerprint(rule);
  if(intent.version)return includesTarget(text,intent);
  if(intent.author){
    if(intent.action==='video-or-content'&&text.includes('编程导航'))return true;
    if(!/bilibili\.com\/video\/BV/i.test(item.finalUrl))return false;
    return [item.author,item.authorName||''].some(author=>normalizeText(author).replace(/^@/,'')===intent.author.replace(/^@/,''))||!item.original&&searched&&text.includes(intent.author);
  }
  if(intent.entity)return text.includes(intent.entity)||intent.entity==='claude'&&/\bsonnet\b|\bopus\b|\bhaiku\b/.test(text);
  const query=normalizeText(rule.query);
  const author=query.match(/^(.+?)(?:的|ai|人工智能|编程导航)/i)?.[1].trim();
  if(author&&/^[\u4e00-\u9fff]{3,}$/.test(author)&&!text.includes(author))return false;
  const groups=[[/ai|人工智能/i,/\bai\b|人工智能/i],[/coding|编程|代码|开发/i,/coding|code|programming|developer|编程|代码|开发/i],[/agents?|智能体/i,/agents?|智能体/i],[/教程|教学|课程|tutorial/i,/tutorial|walkthrough|course|教程|教学|课程/i]];
  const required=groups.filter(([pattern])=>pattern.test(query));
  if(required.length>=2){
    if(/coding|编程|代码|开发/i.test(query)&&!/coding|code|programming|developer|编程|代码|开发/i.test(text))return false;
    return required.filter(([,pattern])=>pattern.test(text)).length>=2;
  }
  const base=query.replace(/相关内容|相关信息|相关动态|最新消息|有关|的最新|的视频|的|教程|内容/g,' ');
  const anchors=base.match(/[a-z0-9][a-z0-9._-]*|[\u4e00-\u9fff]{2,}/g)||[];
  return searched||anchors.some(anchor=>text.includes(anchor));
}

// This is a sourced collection entry, never a fabricated semantic assessment.
// Projected on read; notification digests snapshot the selected entries separately.
export function collectedSignals(candidates:Candidate[],rules:Rule[],events:Signal[],now=Date.now()):Signal[] {
  const displayed=new Set(events.flatMap(event=>event.evidence.map(evidenceKey)));
  const result:Signal[]=[];
  for(const raw of mergeEvidence(candidates) as Candidate[]){
    if(displayed.has(evidenceKey(raw))||raw.supportingOnly||['unrelated','weak'].includes(raw.relevanceExclusion?.category||''))continue;
    if(raw.sourceKind==='x'){
      if(!raw.original||raw.postType!=='original')continue;
      // Engagement ranks collection entries; it no longer gates their visibility.
      const check=applyQuality({...raw,...TWITTER_MINIMUM,metricsUnavailable:false},[],timestamp(raw.publishedAt,now)||now);
      if(check.quality?.decision==='filtered')continue;
    }else if(raw.quality?.decision==='filtered'&&raw.quality.reason!=='超过 5 天，自动排除并停止重试')continue;
    const url=new URL(raw.finalUrl);
    if(/(^|\.)(bing|sogou|baidu|duckduckgo|brave)\.com$/.test(url.hostname)||/^\/(?:search|tag|category)(?:\/|$)/i.test(url.pathname))continue;
    if(raw.title.trim().length<4||raw.text.trim().length<12)continue;
    const matched=rules.filter(rule=>discoveryMatches(raw,rule));if(!matched.length)continue;
    const discovered=raw.firstDiscoveredAt||raw.fetchedAt;
    if(timestamp(discovered,now)===null||raw.publishedAt&&timestamp(raw.publishedAt,now)===null)continue;
    const evidence={...raw,quality:{version:raw.quality?.version||2,decision:'eligible' as const,reason:'已采集的来源信息'}};
    const id='collected-'+hash(evidenceKey(raw));
    result.push({id,eventKey:id,title:raw.title,summary:raw.text.slice(0,500),entity:raw.author,version:'',eventType:'collected',occurredAt:raw.publishedAt,status:'pending',reason:'',attention:0,attentionReason:'',tags:[],evidence:[evidence],ruleIds:matched.map(rule=>rule.id),firstSeenAt:discovered,updatedAt:raw.fetchedAt,discoveryOnly:true});
  }
  return result;
}
