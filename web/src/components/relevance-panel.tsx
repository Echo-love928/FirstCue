import type { Signal } from '../../../shared/types.js';
import { directAssessments } from '../../../shared/relevance.js';

export function targetSummary(signal: Signal, ruleId: string): string {
  const matches=directAssessments(signal,ruleId==='all'?undefined:ruleId);
  return [...new Set(matches.slice(0,2).map(match=>match.summary.trim()).filter(Boolean))].join(' ') || signal.summary;
}
export function RelevanceSummary({signal,ruleId,expanded=false}:{signal:Signal;ruleId:string;expanded?:boolean}) {
  const matches=directAssessments(signal,ruleId==='all'?undefined:ruleId);
  if(!matches.length)return null;
  return <div className="relevance-summary">{(expanded?matches:matches.slice(0,2)).map(match=><div key={match.ruleId}><span className="relevance-label">直接相关 · {match.ruleQuery}</span><span>{match.reason}</span></div>)}{!expanded && matches.length>2 && <span className="small">另有 {matches.length-2} 个直接相关监控，详见证据</span>}</div>;
}
