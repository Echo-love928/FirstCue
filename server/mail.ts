import nodemailer from 'nodemailer';
import type { MailJob, Rule, Signal } from '../shared/types.js';
import { config, safeError } from './config.js';
import { Store } from './db.js';
import { hash } from './parse.js';
import { currentSignal } from '../shared/freshness.js';
import { directAssessments, matchesRule } from '../shared/relevance.js';
import { flushDigestJobs, mailDigestContent } from './digest.js';
export function eligible(signal: Signal, rule: Rule, now=Date.now()): boolean { return currentSignal(signal,now) && rule.enabled && rule.notify && rule.kind === 'keyword' && signal.status === 'confirmed' && matchesRule(signal, rule) && !signal.relevanceRechecked && !!rule.baselineAt && !!signal.occurredAt && Date.parse(signal.occurredAt) > Date.parse(rule.baselineAt); }
export function queueNotifications(store: Store, signals: Signal[], rules: Rule[], now = Date.now()): number {
  let count = 0;
  store.transaction(() => { for (const signal of signals) for (const rule of rules) { if (!eligible(signal, rule,now)) continue; const id = hash(`${rule.id}:${signal.id}`); if (store.get('mail', id)) continue;
    const job: MailJob = { id, eventId: signal.id, ruleId: rule.id, title: signal.title, recipient: store.settings().recipient, status: 'pending', attempts: 0, nextAttemptAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), submittedAt: null, error: null, messageId: `<${id}@signal.local>`, signal };
    store.put('mail', id, job); count++;
  } }); return count;
}
const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
export function mailContent(signal: Signal, ruleName = '', ruleId?:string): { text: string; html: string } {
  const assessment=directAssessments(signal,ruleId)[0];const summary=assessment?.summary||signal.summary;const connection=assessment?.reason||'';
  const links = signal.evidence.filter(item => item.original).map(item => ({ title: item.title, url: item.finalUrl }));
  return { text: `${signal.title}\n\n${summary}\n\n命中监控：${ruleName}\n匹配原因：${connection}\n核实依据：${signal.reason}\n发现时间：${signal.firstSeenAt}\n\n${links.map(link => `${link.title}\n${link.url}`).join('\n\n')}`,
    html: `<h2>${escape(signal.title)}</h2><p>${escape(summary)}</p><p>命中监控：${escape(ruleName)}</p><p><strong>匹配原因：</strong>${escape(connection)}</p><p><strong>核实依据：</strong>${escape(signal.reason)}</p><p>发现时间：${escape(signal.firstSeenAt)}</p><ul>${links.map(link => `<li><a href="${escape(link.url)}">${escape(link.title)}</a></li>`).join('')}</ul>` };
}
export interface MailTransport { verify(): Promise<unknown>; sendMail(message: Record<string, unknown>): Promise<{ accepted: unknown[]; rejected?: unknown[] }>; }
export function mailConfigured(): boolean { return !!(config.smtpHost && config.smtpUser && config.smtpPass && config.smtpFrom); }
export class Mailer {
  transport: MailTransport;
  constructor(public store: Store, transport?: MailTransport) { this.transport = transport || nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, requireTLS: !config.smtpSecure, auth: { user: config.smtpUser, pass: config.smtpPass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 }); }
  async verify(): Promise<void> { if (!mailConfigured()) throw new Error('SMTP 未配置，请填写 .env 后重启'); await this.transport.verify(); }
  async test(): Promise<void> { await this.verify(); const recipient = this.store.settings().recipient; if (!recipient) throw new Error('请先填写接收邮箱'); const response = await this.transport.sendMail({ from: config.smtpFrom, to: recipient, subject: '[FirstCue] 邮件通知测试', text: '这是一封 FirstCue 测试邮件。收到它后，邮件通知链路可以进行验收。' }); if (!response.accepted.length || response.rejected?.length) throw new Error('SMTP 未接受测试邮件的收件人'); }
  async flush(now = Date.now(), allowTestTransport = false, legacy = false): Promise<void> {
    if (!mailConfigured() && !allowTestTransport || !this.store.settings().recipient) return;
    if(!legacy){
      await flushDigestJobs(this.store,'mail',async(job,digest)=>{
        const result=await this.transport.sendMail({from:config.smtpFrom,to:job.recipient,subject:`[FirstCue] ${job.title}`,messageId:'messageId' in job?job.messageId:`<digest-${job.id}@signal.local>`,...mailDigestContent(digest)});
        if(!result.accepted.length||result.rejected?.length)throw Error('SMTP 未接受汇总邮件的收件人');
      },now);return;
    }
    for (const job of this.store.list<MailJob>('mail').filter(item => ['pending', 'retry'].includes(item.status) && Date.parse(item.nextAttemptAt) <= now).slice(0, 10)) {
      const rule = this.store.get<Rule>('rules', job.ruleId); const signal = this.store.get<Signal>('events', job.eventId);
      if (!rule || !signal || !eligible(signal, rule,now)) { this.store.put('mail', job.id, { ...job, status: 'failed', error: '监控已暂停/删除、事件过期或核验状态改变，取消发送' }); continue; }
      const updated = { ...job, recipient: this.store.settings().recipient, attempts: job.attempts + 1, signal };
      try { const result = await this.transport.sendMail({ from: config.smtpFrom, to: updated.recipient, subject: `[FirstCue] ${signal.title}`, messageId: updated.messageId, ...mailContent(signal, rule.name,rule.id) }); if (!result.accepted.length || result.rejected?.length) throw new Error('SMTP 未接受收件人'); this.store.put('mail', job.id, { ...updated, status: 'submitted', submittedAt: new Date(now).toISOString(), error: null }); }
      catch (error) { this.store.put('mail', job.id, { ...updated, status: updated.attempts >= 4 ? 'failed' : 'retry', nextAttemptAt: new Date(now + 60000 * 2 ** updated.attempts).toISOString(), error: safeError(error) }); }
    }
  }
}
