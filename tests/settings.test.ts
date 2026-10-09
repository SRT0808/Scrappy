import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import nodemailer from 'nodemailer';
import handler from '../api/settings.js';
import { testNotifications, sendNtfy, sendEmail } from '../lib/server/settings.js';
import { COOKIE_NAME, createSession, type ApiRequest } from '../lib/server/auth.js';

process.env.ACCESS_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
const originalFetch = globalThis.fetch;
const originalTransport = nodemailer.createTransport;
afterEach(() => { globalThis.fetch = originalFetch; nodemailer.createTransport = originalTransport; });
function request(method = 'GET', body?: unknown, query = ''): ApiRequest {
  return { method, url: `/api/settings${query}`, body, socket: { encrypted: true }, headers: {
    host: 'scrappy.example', origin: 'https://scrappy.example', 'content-type': 'application/json',
    cookie: `${COOKIE_NAME}=${createSession()}`,
  } } as unknown as ApiRequest;
}
async function invoke(req: ApiRequest) {
  let body = '';
  const res = { statusCode: 200, setHeader() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(body) };
}
function database() {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    assert.equal(new Headers(options?.headers).get('apikey'), 'test-server-key');
    calls.push({ url: path, body: options?.body ? JSON.parse(String(options.body)) : null });
    return options?.method === 'GET' ? Response.json([]) : new Response(null, { status: 204 });
  };
  return calls;
}
test('settings protects reads, same-origin mutations and JSON before storage', async () => {
  const calls = database();
  const anonymous = request(); anonymous.headers.cookie = '';
  assert.equal((await invoke(anonymous)).status, 401);
  const cross = request('POST', { action: 'test' }); cross.headers.origin = 'https://evil.example';
  assert.equal((await invoke(cross)).status, 403);
  const content = request('PATCH', {}); content.headers['content-type'] = 'text/plain';
  assert.equal((await invoke(content)).status, 415);
  assert.equal((await invoke(request('DELETE'))).status, 405);
  assert.equal(calls.length, 0);
});
test('empty database gives six hours and useful empty state without migration', async () => {
  database();
  assert.deepEqual((await invoke(request())).body, { default_interval_hours: 6, last_run: null, notifications: [], has_more: false });
  assert.deepEqual((await invoke(request('GET', undefined, '?view=defaults'))).body, { default_interval_hours: 6 });
});
test('interval validation rejects strings, unsupported values and unrelated setting keys', async () => {
  const calls = database();
  for (const body of [{ default_interval_hours: 4 }, { default_interval_hours: '6' }, { default_interval_hours: 6, key: 'secret' }, null])
    assert.equal((await invoke(request('PATCH', body))).status, 400);
  assert.equal(calls.length, 0);
  for (const hours of [3, 6, 12, 24]) assert.equal((await invoke(request('PATCH', { default_interval_hours: hours }))).status, 200);
  assert.deepEqual(calls[0].body, { key: 'default_interval_hours', value: 3 });
});
test('history is bounded, ordered, and omits payload secrets and raw errors', async () => {
  let historyUrl = '';
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.includes('/settings?')) return Response.json([{ value: 12 }]);
    if (path.includes('/runs?')) return Response.json([{ id: 'run', started_at: '2026-10-09T01:00:00Z', finished_at: null,
      trigger: 'cron', checked: 2, ok_count: 1, fail_count: 1 }]);
    historyUrl = path;
    return Response.json(Array.from({ length: 21 }, (_, i) => ({ id: String(i), type: 'test', channel: 'email', status: 'failed',
      sent_at: '2026-10-09T01:00:00Z', payload: { title: 'Prueba', secret: 'sensitive' }, error: 'smtp password' })));
  };
  const result = await invoke(request('GET', undefined, '?page=2'));
  assert.equal(result.status, 200); assert.equal(result.body.notifications.length, 20); assert.equal(result.body.has_more, true);
  assert.ok(historyUrl.includes('offset=40')); assert.ok(historyUrl.includes('order=sent_at.desc,id.desc'));
  assert.ok(!JSON.stringify(result.body).includes('sensitive')); assert.ok(!JSON.stringify(result.body).includes('password'));
  for (const page of ['-1', '1.5', '10001', '0&page=1']) assert.equal((await invoke(request('GET', undefined, `?page=${page}`))).status, 400);
});
test('storage failure and malformed stored intervals fail closed', async () => {
  globalThis.fetch = async () => Response.json([{ value: 4 }]);
  assert.equal((await invoke(request())).status, 503);
  globalThis.fetch = async () => new Response('', { status: 500 });
  assert.equal((await invoke(request('PATCH', { default_interval_hours: 6 }))).status, 503);
});
test('both channels are attempted and audited independently on delivery failure', async () => {
  const calls = database(); const tried: string[] = [];
  const result = await testNotifications({ ntfy: async () => { tried.push('ntfy'); throw new Error('private topic'); }, email: async () => { tried.push('email'); } });
  assert.deepEqual(tried.sort(), ['email', 'ntfy']);
  assert.deepEqual(result, [{ channel: 'ntfy', status: 'failed', recorded: true }, { channel: 'email', status: 'sent', recorded: true }]);
  assert.equal(calls.length, 2); assert.ok(!JSON.stringify(calls).includes('private topic'));
});
test('audit failure retains confirmed delivery and does not retry sends', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });
  let sends = 0;
  const result = await testNotifications({ ntfy: async () => { sends++; }, email: async () => { sends++; throw new Error(); } });
  assert.equal(sends, 2);
  assert.deepEqual(result, [{ channel: 'ntfy', status: 'sent', recorded: false }, { channel: 'email', status: 'failed', recorded: false }]);
});
test('ntfy requires a confirmed receipt and email requires an accepted recipient', async () => {
  process.env.NTFY_TOPIC = 'a'.repeat(24);
  globalThis.fetch = async () => Response.json({ event: 'message', id: 'receipt' });
  await sendNtfy();
  globalThis.fetch = async () => Response.json({ event: 'message' });
  await assert.rejects(sendNtfy);
  process.env.GMAIL_USER = 'test@example.com'; process.env.GMAIL_APP_PASSWORD = 'private'; process.env.NOTIFY_EMAIL_TO = 'test@example.com';
  let closed = 0;
  nodemailer.createTransport = (() => ({ sendMail: async () => ({ accepted: [], rejected: ['test@example.com'] }), close: () => { closed++; } })) as unknown as typeof nodemailer.createTransport;
  await assert.rejects(sendEmail); assert.equal(closed, 1);
});
test('POST sends both channels, returns individual receipts and persists test history', async () => {
  const calls = database(); const dbFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url) === 'https://ntfy.sh/' ? Response.json({ event: 'message', id: 'receipt' }) : dbFetch(url, options);
  nodemailer.createTransport = (() => ({ sendMail: async () => ({ accepted: ['test@example.com'], rejected: [] }), close() {} })) as unknown as typeof nodemailer.createTransport;
  const result = await invoke(request('POST', { action: 'test' }));
  assert.equal(result.status, 200); assert.ok(result.body.deliveries.every((d: { status: string; recorded: boolean }) => d.status === 'sent' && d.recorded));
  assert.equal(calls.length, 2);
  assert.equal((await invoke(request('POST', { action: 'other' }))).status, 400);
});
