import nodemailer from 'nodemailer';
import type { Delivery, Settings } from '../settings-contract.js';
import { isSettings, validInterval } from '../settings-contract.js';

export async function settingsDatabase(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || new URL(url).protocol !== 'https:' || !key) throw new Error('Missing database configuration');
  const response = await fetch(new URL(`/rest/v1/${path}`, url), { method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Settings storage unavailable');
  return method === 'GET' ? response.json() : null;
}

export async function defaultInterval(): Promise<number> {
  const rows = await settingsDatabase('settings?key=eq.default_interval_hours&select=value');
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid settings');
  const value: unknown = rows.length ? rows[0]?.value : 6;
  if (!validInterval(value)) throw new Error('Invalid interval');
  return value;
}

export async function readSettings(page: number): Promise<Settings> {
  const [interval, runs, notifications] = await Promise.all([
    defaultInterval(), settingsDatabase('runs?select=id,started_at,finished_at,trigger,checked,ok_count,fail_count&order=started_at.desc,id.desc&limit=1'),
    settingsDatabase(`notifications?select=id,type,channel,status,payload,sent_at&order=sent_at.desc,id.desc&limit=21&offset=${page * 20}`),
  ]);
  if (!Array.isArray(runs) || !Array.isArray(notifications)) throw new Error('Invalid settings response');
  const result = { default_interval_hours: interval, last_run: runs[0] ?? null, has_more: notifications.length > 20,
    notifications: notifications.slice(0, 20).map(n => ({ id: n.id, type: n.type, channel: n.channel, status: n.status,
      sent_at: n.sent_at, title: typeof n.payload?.title === 'string' ? n.payload.title : 'Notificación de Scrappy',
      error: n.status === 'failed' ? `No se pudo enviar por ${n.channel === 'email' ? 'correo' : 'ntfy'}.` : null })) };
  if (!isSettings(result)) throw new Error('Invalid settings response');
  return result;
}

const payload = { title: '✅ Notificación de prueba de Scrappy', message: '✅ Notificación de prueba de Scrappy', priority: 3, tags: ['white_check_mark'] };
export async function sendNtfy(): Promise<void> {
  const topic = process.env.NTFY_TOPIC?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{24,}$/.test(topic)) throw new Error('Missing ntfy configuration');
  const response = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, ...payload }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('ntfy delivery failed');
  const receipt = await response.json();
  if (receipt.event !== 'message' || !receipt.id) throw new Error('Missing ntfy receipt');
}
export async function sendEmail(): Promise<void> {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.trim();
  const to = process.env.NOTIFY_EMAIL_TO?.trim();
  if (!user || !pass || !to) throw new Error('Missing email configuration');
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true });
  try {
    const receipt = await transport.sendMail({ from: user, to, subject: payload.title, text: payload.message });
    if (!receipt.accepted.length || receipt.rejected.length) throw new Error('Email rejected');
  } finally { transport.close(); }
}
export async function testNotifications(channels = { ntfy: sendNtfy, email: sendEmail }): Promise<Delivery[]> {
  const now = new Date().toISOString();
  return Promise.all((['ntfy', 'email'] as const).map(async channel => {
    let status: Delivery['status'] = 'sent';
    try { await channels[channel](); } catch { status = 'failed'; }
    let recorded = true;
    try { await settingsDatabase('notifications', 'POST', { product_id: null, type: 'test', channel, status, payload,
      error: status === 'failed' ? `No se pudo enviar por ${channel}.` : null, sent_at: now }); }
    catch { recorded = false; }
    return { channel, status, recorded };
  }));
}
