import { lookup } from 'node:dns/promises';
import { Agent, EnvHttpProxyAgent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
export interface HttpDocument { status: number; url: string; headers: Record<string, string>; text: string; }
export interface RequestOptions { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; maxBytes?: number; timeoutMs?: number; allowRedirects?: boolean; }
export interface HttpClient { request(url: string, options?: RequestOptions): Promise<HttpDocument>; }
export function publicAddress(address: string): boolean {
  try { let parsed = ipaddr.parse(address); if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address(); return parsed.range() === 'unicast'; } catch { return false; }
}
export function publicUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('只允许不含凭据的公共 HTTP/HTTPS 地址与标准端口');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !hostname.includes('.') && !hostname.includes(':')) throw new Error('不能采集本地地址');
  if (ipaddr.isValid(hostname) && !publicAddress(hostname)) throw new Error('不能采集私网或保留地址');
  return url;
}
export class PublicHttp implements HttpClient {
  private agent: Agent | EnvHttpProxyAgent;
  private backoff = new Map<string, number>();
  constructor() {
    const guardedLookup = (hostname: string, options: { all?: boolean }, callback: (error: Error | null, address?: unknown, family?: number) => void) => {
      lookup(hostname, { all: true }).then(addresses => {
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return callback(new Error('DNS 指向私网或保留地址，已停止采集'));
        if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
      }).catch(callback);
    };
    const options = { connect: { lookup: guardedLookup as never }, connections: 2 };
    this.agent = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? new EnvHttpProxyAgent(options) : new Agent(options);
  }
  async request(raw: string, options: RequestOptions = {}): Promise<HttpDocument> {
    let url = publicUrl(raw);
    const signal = AbortSignal.timeout(options.timeoutMs || 20000);
    for (let redirects = 0; redirects <= 4; redirects++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const retryAt = this.backoff.get(hostname) || 0;
      if (retryAt > Date.now()) throw new Error(`${hostname} 正在按 Retry-After 退避，${new Date(retryAt).toISOString()} 后再试`);
      const addresses = ipaddr.isValid(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
      if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('DNS 指向私网或保留地址，已停止采集');
      const response = await fetch(url, { method: options.method || 'GET', headers: { 'User-Agent': 'SignalMonitor/0.1 (personal news monitor)', Accept: 'text/html,application/xml,application/json;q=0.9,*/*;q=0.5', ...options.headers }, body: options.body, dispatcher: this.agent, signal, redirect: 'manual' }).catch((error: Error & { cause?: { code?: string } }) => {
        throw new Error(`${hostname} 连接失败：${error.cause?.code || error.message}${signal.aborted ? '（超过请求时限）' : ''}`);
      });
      if (response.status === 429 || [402, 503].includes(response.status) && response.headers.has('retry-after')) {
        const value = response.headers.get('retry-after'); const delay = value && /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : 60000;
        this.backoff.set(hostname, Date.now() + (Number.isFinite(delay) ? Math.max(delay, 1000) : 60000));
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (options.allowRedirects === false || options.headers?.Authorization || options.headers?.['X-API-Key']) throw new Error('拒绝将服务凭据转发到重定向地址');
        const location = response.headers.get('location'); if (!location) throw new Error('重定向没有目标地址');
        url = publicUrl(new URL(location, url).href); continue;
      }
      const max = options.maxBytes || 2 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('响应超过大小上限'); }
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try { if (reader) for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > max) { await reader.cancel(); throw new Error('响应超过大小上限'); } chunks.push(result.value); } } finally { reader?.releaseLock(); }
      return { status: response.status, url: url.href, headers: Object.fromEntries(response.headers), text: Buffer.concat(chunks).toString('utf8') };
    }
    throw new Error('重定向次数超限');
  }
  async close(): Promise<void> { await this.agent.close(); }
}
export function checkHttp(doc: HttpDocument): void {
  if (doc.status === 429) throw new Error(`来源限流 (429)，Retry-After: ${doc.headers['retry-after'] || '未提供'}`);
  if (doc.status === 401 || doc.status === 403) throw new Error(`来源拒绝访问 (${doc.status})，请检查凭据或稍后重试`);
  if (doc.status < 200 || doc.status >= 300) {
    let detail = ''; try { const body = JSON.parse(doc.text); const message = body.error?.message || body.message; if (typeof message === 'string') detail = `：${message.slice(0, 240)}`; } catch { /* Do not echo HTML error pages. */ }
    throw new Error(`来源请求失败 (${doc.status})${detail}`);
  }
}
