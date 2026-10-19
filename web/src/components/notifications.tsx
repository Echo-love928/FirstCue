import { useState } from 'react';
import { ArrowUpRight, Bell, CircleHelp, Loader2, Mail, MessageSquare } from 'lucide-react';
import type { Dashboard, Signal } from '../../../shared/types.js';

export function FeishuSettingsCard({ configured, signing, enabled, dirty, busy, onChange, onTest }: {
  configured: boolean; signing: boolean; enabled: boolean; dirty: boolean; busy: string;
  onChange: (enabled: boolean) => void; onTest: () => void;
}) {
  return <section className="settings-card">
    <h2><MessageSquare size={20}/> 飞书群通知 <span className={`pill ${configured ? 'confirmed' : 'pending'}`}>{configured ? 'Webhook 已配置' : '待配置 Webhook'}</span></h2>
    <label className="checkbox-label"><input type="checkbox" checked={enabled} disabled={!!busy || (!configured && !enabled)} onChange={event => onChange(event.target.checked)}/> 启用飞书，与邮箱同时通知</label>
    <p className="field-help">每 30 分钟整体汇总开启通知的监控所命中的精选热点，无需等待核实。邮箱和飞书各发送一份，独立记录结果；没有新增精选时不发送空消息。</p>
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
  const [details,setDetails]=useState<Record<string,{signals:Signal[];loading:boolean;error:string}>>({});
  const load=async(channel:string,id:string)=>{
    const key=`${channel}:${id}`;if(details[key]&&!details[key].error)return;
    setDetails(previous=>({...previous,[key]:{signals:[],loading:true,error:''}}));
    try{const response=await fetch(`/api/notifications/${channel}/${id}`);const job=await response.json();if(!response.ok)throw Error(job.error||'读取汇总失败');setDetails(previous=>({...previous,[key]:{signals:job.digest?.signals||[],loading:false,error:''}}));}
    catch(error){setDetails(previous=>({...previous,[key]:{signals:[],loading:false,error:error instanceof Error?error.message:'读取汇总失败'}}));}
  };
  const notifications = data.notifications.filter(job => channel === 'all' || job.channel === channel);
  const labels = { pending: '待发送', retry: '等待重试', submitted: '已接受', failed: '失败' };
  const time = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  return <section className="page-section">
    <div className="section-heading"><div><h1>通知，有迹可循。</h1><p>每 30 分钟汇总精选热点，邮箱和飞书各发一份；已发送内容去重，没有新增时不发空汇总。</p>{data.notificationSchedule&&<p>下次汇总：{time(data.notificationSchedule.nextAt)}（北京时间）</p>}</div><button className="button" onClick={onSettings}>配置通知渠道<ArrowUpRight size={14}/></button></div>
    <div className="button-row">
      <button className="button" disabled={!!busy || !data.configured.mail || !data.settings.recipient} onClick={() => void act('test-mail', () => post('/services/mail-test'))}><Mail size={16}/> 发送测试邮件</button>
      <button className="button" disabled={!!busy || !data.configured.feishu} onClick={() => void act('feishu-test', () => post('/services/feishu-test'))}>{busy === 'feishu-test' ? <Loader2 size={16} className="spin"/> : <MessageSquare size={16}/>} 发送飞书测试消息</button>
    </div>
    <div className="segmented notification-filters" role="group" aria-label="通知渠道筛选">{([['all', '全部渠道'], ['mail', '邮箱'], ['feishu', '飞书']] as const).map(([value, label]) => <button key={value} type="button" className={channel === value ? 'active' : ''} aria-pressed={channel === value} onClick={() => setChannel(value)}>{label}</button>)}</div>
    {notifications.length ? <div className="notification-list">{notifications.map(job => <article className="notification" key={`${job.channel}:${job.id}`}>
      <div className="notification-icon">{job.channel === 'feishu' ? <MessageSquare size={21}/> : <Mail size={21}/>}</div>
      <div><h3>{job.title}</h3><p>{job.channel === 'feishu' ? '飞书' : '邮箱'} · {job.recipient || '接收邮箱尚未设置'} · {time(job.createdAt)}</p>{job.digest&&<details onToggle={event=>{if(event.currentTarget.open)void load(job.channel,job.id);}}><summary>查看本期 {job.digest.count??job.digest.signals.length} 条热点</summary>{details[`${job.channel}:${job.id}`]?.loading?<p>正在读取完整汇总…</p>:details[`${job.channel}:${job.id}`]?.error?<p className="error-text">{details[`${job.channel}:${job.id}`].error}</p>:<ol>{details[`${job.channel}:${job.id}`]?.signals.map(signal=><li key={signal.id}><strong>{signal.title}</strong><p>{signal.summary}</p>{signal.evidence[0]&&<a href={signal.evidence[0].finalUrl} target="_blank" rel="noopener noreferrer">查看原始来源</a>}</li>)}</ol>}</details>}{job.error && <p className="error-text">{job.error}</p>}</div>
      <span className={`pill ${job.status === 'submitted' ? 'confirmed' : job.status === 'failed' ? 'rejected' : 'pending'}`}>{job.status === 'submitted' ? job.channel === 'feishu' ? '飞书已接受' : 'SMTP 已接受' : labels[job.status]}</span>
      {job.status === 'failed' && (job.digest||!data.notificationSchedule) && <button className="text-button" disabled={!!busy} aria-label={`重试${job.channel === 'feishu' ? '飞书' : '邮箱'}通知：${job.title}`} onClick={() => void act(`${job.channel}:${job.id}`, () => post(`/${job.channel}/${job.id}/retry`))}>重试</button>}
    </article>)}</div> : <div className="empty-state"><div className="empty-icon"><Bell size={31}/></div><h3>还没有{channel === 'all' ? '' : channel === 'feishu' ? '飞书' : '邮件'}汇总通知</h3><p>开启通知的监控所命中的精选信息会每 30 分钟汇总显示在这里。请确认对应监控和通知渠道均已启用。</p></div>}
    <div className="note"><CircleHelp size={17}/><span>“已接受”表示对应服务已接受发送请求，不代表已读。首次使用请确认邮箱和飞书群实际收到消息。</span></div>
  </section>;
}
