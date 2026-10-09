import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import type { ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import login from '../api/login.js';
import logout from '../api/logout.js';
import session from '../api/session.js';
import { COOKIE_NAME, SESSION_SECONDS, clientIp, createSession, matchesAccessKey, validSession } from '../lib/server/auth.js';
import type { ApiRequest, Handler } from '../lib/server/auth.js';

process.env.ACCESS_KEY = 'test-access-key';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
process.env.VERCEL = '1';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'POST',
    headers: { host: 'scrappy.example', origin: 'https://scrappy.example',
      'content-type': 'application/json', 'x-vercel-forwarded-for': '192.0.2.1' },
    body: { key: 'test-access-key' }, socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as ApiRequest;
}

async function invoke(handler: Handler, req = request()) {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    statusCode: 200,
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, headers, body: JSON.parse(body) };
}

function database(result: unknown = 0, status = 200) {
  const attempts: unknown[] = [];
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url), 'https://example.supabase.co/rest/v1/rpc/record_login_attempt');
    assert.equal(new Headers(options?.headers).get('apikey'), 'test-server-key');
    attempts.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify(result), { status });
  }) as typeof fetch;
  return attempts;
}

test('access key comparison supports Unicode and rejects different lengths', () => {
  assert.equal(matchesAccessKey('test-access-key'), true);
  for (const value of ['', 'test-access-ke', 'test-access-key ', 'á'.repeat(200)]) {
    assert.equal(matchesAccessKey(value), false);
  }
});

test('signed sessions expire at exactly 30 days and reject future, tampered and malformed tokens', () => {
  const now = 1_800_000_000;
  const token = createSession(now);
  assert.equal(validSession(token, now), true);
  assert.equal(validSession(token, now + SESSION_SECONDS - 1), true);
  assert.equal(validSession(token, now + SESSION_SECONDS), false);
  assert.equal(validSession(token, now - 1), false);
  for (const value of ['', 'x'.repeat(300), token.replace('v1.', 'v2.'), token.slice(0, -1),
    token.replace(String(now + SESSION_SECONDS), String(now + SESSION_SECONDS + 1))]) {
    assert.equal(validSession(value, now), false);
  }
  const last = token.at(-1) === 'A' ? 'B' : 'A';
  assert.equal(validSession(token.slice(0, -1) + last, now), false);
});

test('even a correctly signed token cannot extend the configured lifetime', () => {
  const now = 1_800_000_000;
  const payload = `v1.${now}.${now + SESSION_SECONDS + 1}.${'a'.repeat(32)}`;
  const key = createHmac('sha256', process.env.SESSION_SECRET!).update(process.env.ACCESS_KEY!).digest();
  const token = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
  assert.equal(validSession(token, now), false);
});

test('credential rotation invalidates existing sessions', () => {
  const token = createSession();
  const key = process.env.ACCESS_KEY;
  process.env.ACCESS_KEY = 'rotated-access-key';
  try { assert.equal(validSession(token), false); } finally { process.env.ACCESS_KEY = key; }
  const secret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'rotated-session-secret-with-at-least-32-bytes';
  try { assert.equal(validSession(token), false); } finally { process.env.SESSION_SECRET = secret; }
});

test('login records success and sets only a secure host cookie without returning the token', async () => {
  const attempts = database();
  const result = await invoke(login);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { authenticated: true });
  assert.deepEqual(attempts, [{ p_ip: '192.0.2.1', p_success: true }]);
  const cookie = result.headers['set-cookie'];
  for (const flag of ['__Host-scrappy_session=', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=2592000']) {
    assert.ok(cookie.includes(flag));
  }
  assert.ok(!cookie.includes('Domain='));
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('wrong key is recorded and rejected without issuing a cookie', async () => {
  const attempts = database();
  const result = await invoke(login, request({ body: { key: 'incorrect' } }));
  assert.equal(result.status, 401);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.deepEqual(attempts, [{ p_ip: '192.0.2.1', p_success: false }]);
});

test('limit blocks even a correct key and provides Retry-After', async () => {
  for (const retry of [1, 899, 900]) {
    database(retry);
    const result = await invoke(login);
    assert.equal(result.status, 429);
    assert.equal(result.headers['retry-after'], String(retry));
    assert.equal(result.headers['set-cookie'], undefined);
  }
});

test('database errors, malformed RPC results and network failure fail closed', async () => {
  for (const [value, status] of [[null, 200], [-1, 200], [901, 200], [0, 500], ['0', 200], [0.5, 200], [[], 200], [{}, 200]]) {
    database(value, Number(status));
    const result = await invoke(login);
    assert.equal(result.status, 503);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.ok(!JSON.stringify(result).includes('test-server-key'));
  }
  globalThis.fetch = async () => { throw new Error('sensitive transport detail'); };
  const result = await invoke(login);
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});

test('missing or weak server configuration fails closed', async () => {
  database();
  const secret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'weak';
  try { assert.equal((await invoke(login)).status, 503); } finally { process.env.SESSION_SECRET = secret; }
  const url = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try { assert.equal((await invoke(login)).status, 503); } finally { process.env.SUPABASE_URL = url; }
});

test('login rejects invalid bodies, content types, methods and cross-origin requests before database access', async () => {
  const attempts = database();
  for (const body of [null, {}, { key: 123 }, { key: '' }, { key: 'á'.repeat(513) }]) {
    assert.equal((await invoke(login, request({ body }))).status, 400);
  }
  assert.equal((await invoke(login, request({ method: 'GET' }))).status, 405);
  const base = request().headers;
  for (const origin of [undefined, 'https://evil.example', 'null', 'http://scrappy.example']) {
    assert.equal((await invoke(login, request({ headers: { ...base, origin } }))).status, 403);
  }
  assert.equal((await invoke(login, request({ headers: { ...base, 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await invoke(login, request({ headers: { ...base, 'sec-fetch-site': 'same-site' } }))).status, 403);
  assert.equal(attempts.length, 0);
});

test('trusted address rejects spoofed lists and local mode ignores forwarding headers', () => {
  const base = request().headers;
  for (const ip of [undefined, 'invalid', '192.0.2.1, 192.0.2.2']) {
    assert.throws(() => clientIp(request({ headers: { ...base, 'x-vercel-forwarded-for': ip } })));
  }
  assert.equal(clientIp(request({ headers: { ...base, 'x-vercel-forwarded-for': '::ffff:192.0.2.1' } })), '192.0.2.1');
  assert.equal(clientIp(request({ headers: { ...base, 'x-vercel-forwarded-for': '2001:db8::1' } })), '2001:db8::1');
  delete process.env.VERCEL;
  try { assert.equal(clientIp(request()), '127.0.0.1'); } finally { process.env.VERCEL = '1'; }
});

test('every non-login endpoint rejects missing, tampered, expired and duplicate cookies', async () => {
  const token = createSession();
  for (const handler of [session, logout]) {
    for (const cookie of ['', `${COOKIE_NAME}=invalid`, `${COOKIE_NAME}=${createSession(1)}`,
      `${COOKIE_NAME}=${token}; ${COOKIE_NAME}=${token}`]) {
      const result = await invoke(handler, request({ headers: { ...request().headers, cookie } }));
      assert.equal(result.status, 401);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(result.headers['cache-control'], 'no-store');
    }
  }
});

test('authenticated session works and logout clears the cookie with identical security attributes', async () => {
  const headers = { ...request().headers, cookie: `${COOKIE_NAME}=${createSession()}` };
  assert.equal((await invoke(session, request({ headers, method: 'GET' }))).status, 200);
  assert.equal((await invoke(session, request({ headers }))).status, 405);
  const result = await invoke(logout, request({ headers }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { authenticated: false });
  assert.equal(result.headers['set-cookie'], `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  assert.equal((await invoke(logout, request({ headers, method: 'GET' }))).status, 405);
  assert.equal((await invoke(logout, request({ headers: { ...headers, origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await invoke(session, request({ headers: { ...headers, cookie: `${COOKIE_NAME}=` }, method: 'GET' }))).status, 401);
});
