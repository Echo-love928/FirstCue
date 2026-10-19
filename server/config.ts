import 'dotenv/config';
import path from 'node:path';
import type { Settings } from '../shared/types.js';
import { FRESHNESS_HOURS } from '../shared/freshness.js';
export const config = {
  port: Number(process.env.PORT || 3030), dataDir: path.resolve(process.env.DATA_DIR || './data'),
  aiKey: process.env.OPENROUTER_API_KEY || '', xKey: process.env.TWITTERAPI_IO_KEY || '',
  smtpHost: process.env.SMTP_HOST || '', smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: process.env.SMTP_SECURE !== 'false', smtpUser: process.env.SMTP_USER || '', smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || '', trustedXIds: (process.env.TRUSTED_X_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  feishuWebhook: (process.env.FEISHU_WEBHOOK_URL || '').trim(), feishuSecret: (process.env.FEISHU_SIGNING_SECRET || '').trim(),
};
export const INTERVAL_MS = 30 * 60 * 1000;
export const defaults: Settings = { model: process.env.OPENROUTER_MODEL || '', recipient: process.env.NOTIFY_EMAIL || '', feishuEnabled: false, aiDailyLimit: 100, xDailyLimit: 200, xResultDailyLimit: 2000, searchPerRunLimit: 16, candidatePerRunLimit: 30, lookbackHours: FRESHNESS_HOURS };
export function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.aiKey, config.xKey, config.smtpPass, config.feishuWebhook, config.feishuSecret, config.feishuWebhook.split('/').at(-1)]) if (secret) message = message.split(secret).join('[已隐藏]');
  return message.slice(0, 500);
}
