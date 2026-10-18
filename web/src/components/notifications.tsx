import { useState } from 'react';
import { ArrowUpRight, Bell, CircleHelp, Loader2, Mail, MessageSquare } from 'lucide-react';
import type { Dashboard } from '../../../shared/types.js';

export function FeishuSettingsCard({ configured, signing, enabled, dirty, busy, onChange, onTest }: {
  configured: boolean; signing: boolean; enabled: boolean; dirty: boolean; busy: string;
  onChange: (enabled: boolean) => void; onTest: () => void;
}) {
  return <section className="settings-card">
    <h2><MessageSquare size={20}/> 飞书群通知 <span className={`pill ${configured ? 'confirmed' : 'pending'}`}>{configured ? 'Webhook 已配置' : '待配置 Webhook'}</span></h2>
    <label className="checkbox-label"><input type="checkbox" checked={enabled} disabled={!!busy || (!configured && !enabled)} onChange={event => onChange(event.target.checked)}/> 启用飞书，与邮箱同时通知</label>
    <p className="field-help">启用并保存后，只发送之后发现且核实的新事件。邮箱和飞书分别发送、记录及重试。</p>
    <p className="field-help">{configured ? signing ? '已配置签名密钥，请与飞书机器人安全设置保持一致。' : '未配置签名密钥。建议在飞书机器人开启签名校验，并在本地填写密钥。' : '在本地 .env 填写 FEISHU_WEBHOOK_URL 后重启；签名校验密钥填写 FEISHU_SIGNING_SECRET。'}</p>
    {dirty && <p className="field-help" id="feishu-save-hint" role="status">设置有未保存的修改，请先保存再发送测试消息。</p>}
    <div className="button-row">
      {dirty && <button type="submit" className="button" disabled={!!busy}>保存设置</button>}
      <button type="button" className="button" disabled={!!busy || dirty || !configured} aria-describedby={dirty ? 'feishu-save-hint' : undefined} onClick={onTest}>
        {busy === 'feishu-test' ? <Loader2 size={15} className="spin"/> : <MessageSquare size={15}/>} {busy === 'feishu-test' ? '正在发送…' : '发送飞书测试消息'}<ArrowUpRight size={14}/>
      </button>
    </div>
    <p className="field-help">测试消息会实际发送到机器人所在群，不受自动通知开关影响。</p>
  </section>;
}

type Act = (key: string, action: () => Promise<unknown>, message?: string) => Promise<boolean>;
async function post(path: string): Promise<unknown> {
  const response = await fetch(`/api${path}`, { method: 'POST' }); const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请稍后重试'); return result;
}
export function NotificationHistory({ data, busy, act, onSettings }: { data: Dashboard; busy: string; act: Act; onSettings: () => void }) {
  const [channel, setChannel] = useState<'all' | 'mail' | 'feishu'>('all');
  const notifications = data.notifications.filter(job => channel === 'all' || job.channel === channel);
  const labels = { pending: '待发送', retry: '等待重试', submitted: '已接受', failed: '失败' };
  const time = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  return <section className="page-section">
    <div className="section-heading"><div><h1>通知，有迹可循。</h1><p>邮箱与飞书同时发送，各自记录结果、去重与重试。</p></div><button className="button" onClick={onSettings}>配置通知渠道<ArrowUpRight size={14}/></button></div>
    <div className="button-row">
      <button className="button" disabled={!!busy || !data.configured.mail || !data.settings.recipient} onClick={() => void act('test-mail', () => post('/services/mail-test'))}><Mail size={16}/> 发送测试邮件</button>
      <button className="button" disabled={!!busy || !data.configured.feishu} onClick={() => void act('feishu-test', () => post('/services/feishu-test'))}>{busy === 'feishu-test' ? <Loader2 size={16} className="spin"/> : <MessageSquare size={16}/>} 发送飞书测试消息</button>
    </div>
    <div className="segmented notification-filters" role="group" aria-label="通知渠道筛选">{([['all', '全部渠道'], ['mail', '邮箱'], ['feishu', '飞书']] as const).map(([value, label]) => <button key={value} type="button" className={channel === value ? 'active' : ''} aria-pressed={channel === value} onClick={() => setChannel(value)}>{label}</button>)}</div>
    {notifications.length ? <div className="notification-list">{notifications.map(job => <article className="notification" key={`${job.channel}:${job.id}`}>
      <div className="notification-icon">{job.channel === 'feishu' ? <MessageSquare size={21}/> : <Mail size={21}/>}</div>
      <div><h3>{job.title}</h3><p>{job.channel === 'feishu' ? '飞书' : '邮箱'} · {job.recipient || '接收邮箱尚未设置'} · {time(job.createdAt)}</p>{job.error && <p className="error-text">{job.error}</p>}</div>
      <span className={`pill ${job.status === 'submitted' ? 'confirmed' : job.status === 'failed' ? 'rejected' : 'pending'}`}>{job.status === 'submitted' ? job.channel === 'feishu' ? '飞书已接受' : 'SMTP 已接受' : labels[job.status]}</span>
      {job.status === 'failed' && <button className="text-button" disabled={!!busy} aria-label={`重试${job.channel === 'feishu' ? '飞书' : '邮箱'}通知：${job.title}`} onClick={() => void act(`${job.channel}:${job.id}`, () => post(`/${job.channel}/${job.id}/retry`))}>重试</button>}
    </article>)}</div> : <div className="empty-state"><div className="empty-icon"><Bell size={31}/></div><h3>还没有{channel === 'all' ? '' : channel === 'feishu' ? '飞书' : '邮件'}通知</h3><p>新增且核实的关键词命中会显示在这里。请先配置通知渠道，并发送测试消息确认收件。</p></div>}
    <div className="note"><CircleHelp size={17}/><span>“已接受”表示对应服务已接受发送请求，不代表已读。首次使用请确认邮箱和飞书群实际收到消息。</span></div>
  </section>;
}
