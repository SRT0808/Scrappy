import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import collection from '../api/lists/index.js';
import item from '../api/lists/[id].js';
import reorder from '../api/lists/reorder.js';
import { COOKIE_NAME, createSession } from '../lib/server/auth.js';
import type { ApiRequest, Handler } from '../lib/server/auth.js';

process.env.ACCESS_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
process.env.VERCEL = '1';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const row = { id, name: 'Tecnología', emoji: '📱', position: 0, created_at: '2026-10-08T00:00:00Z' };

function request(method: string, body?: unknown): ApiRequest {
  return { method, url: `/api/lists/${id}`, body, socket: {}, headers: {
    host: 'scrappy.example', origin: 'https://scrappy.example',
    'content-type': 'application/json', cookie: `${COOKIE_NAME}=${createSession()}`,
  } } as ApiRequest;
}

async function invoke(handler: Handler, req: ApiRequest) {
  let body = '';
  const headers: Record<string, string> = {};
  const res = { statusCode: 200,
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, headers, body: JSON.parse(body) };
}

function database(result: unknown, status = 200) {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('apikey'), 'test-server-key');
    assert.equal(headers.get('authorization'), 'Bearer test-server-key');
    assert.ok(options?.signal);
    calls.push({ url: String(url), method: options?.method, body: options?.body ? JSON.parse(String(options.body)) : null });
    return new Response(JSON.stringify(result), { status });
  };
  return calls;
}

test('all list operations require a valid unique session before database access', async () => {
  const calls = database([]);
  for (const [handler, method] of [[collection, 'GET'], [collection, 'POST'], [item, 'PATCH'], [item, 'DELETE'], [reorder, 'PUT']] as const) {
    for (const cookie of ['', `${COOKIE_NAME}=bad`, `${COOKIE_NAME}=${createSession(1)}`,
      `${COOKIE_NAME}=${createSession()}; ${COOKIE_NAME}=${createSession()}`]) {
      const req = request(method);
      req.headers.cookie = cookie;
      assert.equal((await invoke(handler, req)).status, 401);
    }
  }
  assert.equal(calls.length, 0);
});

test('mutations reject cross-origin, missing origin and same-site requests', async () => {
  const calls = database([]);
  for (const [handler, method] of [[collection, 'POST'], [item, 'PATCH'], [item, 'DELETE'], [reorder, 'PUT']] as const) {
    for (const origin of ['https://evil.example', undefined]) {
      const req = request(method);
      req.headers.origin = origin;
      assert.equal((await invoke(handler, req)).status, 403);
    }
    const req = request(method);
    req.headers['sec-fetch-site'] = 'same-site';
    assert.equal((await invoke(handler, req)).status, 403);
  }
  assert.equal(calls.length, 0);
});

test('listing uses deterministic order, server credentials and no cache', async () => {
  for (const rows of [[], [row]]) {
    const calls = database(rows);
    const result = await invoke(collection, request('GET'));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { lists: rows });
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(calls[0].url.endsWith('order=position.asc,created_at.asc,id.asc'));
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, null);
  }
});

test('create trims name and appends through the atomic RPC, with optional emoji', async () => {
  const calls = database(row);
  assert.equal((await invoke(collection, request('POST', { name: '  Tecnología  ', emoji: '📱' }))).status, 201);
  assert.deepEqual(calls[0].body, { p_operation: 'create', p_name: 'Tecnología', p_emoji: '📱' });
  assert.ok(calls[0].url.endsWith('/rpc/mutate_list'));
  assert.equal(calls[0].method, 'POST');
  assert.equal((await invoke(collection, request('POST', { name: 'Otra' }))).status, 201);
  assert.deepEqual(calls[1].body, { p_operation: 'create', p_name: 'Otra', p_emoji: null });
});

test('rename preserves omitted emoji and can explicitly clear it', async () => {
  const calls = database(row);
  for (const body of [{ name: 'Nuevo' }, { name: 'Nuevo', emoji: null }, { name: 'Nuevo', emoji: '💻' }]) {
    const result = await invoke(item, request('PATCH', body));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { list: row });
  }
  assert.deepEqual(calls[0].body, { p_operation: 'rename', p_id: id, p_name: 'Nuevo', p_emoji: null, p_set_emoji: false });
  assert.equal((calls[1].body as Record<string, unknown>).p_set_emoji, true);
  assert.equal((calls[2].body as Record<string, unknown>).p_emoji, '💻');
});

test('reorder sends complete order in one RPC, including empty collection', async () => {
  const calls = database([row]);
  assert.equal((await invoke(reorder, request('PUT', { ids: [secondId, id] }))).status, 200);
  assert.deepEqual(calls[0].body, { p_operation: 'reorder', p_ids: [secondId, id] });
  database([]);
  assert.deepEqual((await invoke(reorder, request('PUT', { ids: [] }))).body, { lists: [] });
});

test('delete sends only the validated id and reports success', async () => {
  const calls = database(null);
  const result = await invoke(item, request('DELETE'));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { deleted: true });
  assert.deepEqual(calls[0].body, { p_operation: 'delete', p_id: id });
});

test('invalid names, emoji, fields and body shapes never reach storage', async () => {
  const calls = database(row);
  for (const handler of [collection, item]) {
    const method = handler === collection ? 'POST' : 'PATCH';
    for (const body of [undefined, null, [], 'name', {}, { name: '' }, { name: ' \n ' },
      { name: 42 }, { name: 'a'.repeat(101) }, { name: 'ok', emoji: 1 },
      { name: 'ok', emoji: '😀'.repeat(17) }, { name: 'ok', position: 1 }, { name: 'ok', id }]) {
      assert.equal((await invoke(handler, request(method, body))).status, 400);
    }
  }
  assert.equal(calls.length, 0);
  assert.equal((await invoke(collection, request('POST', { name: '😀'.repeat(100) }))).status, 201);
});

test('invalid reorder and ids are rejected without storage access', async () => {
  const calls = database([]);
  for (const body of [null, [], {}, { ids: 'x' }, { ids: [null] }, { ids: ['x'] },
    { ids: [id, id] }, { ids: [id, id.toUpperCase()] }, { ids: [], position: 1 }]) {
    assert.equal((await invoke(reorder, request('PUT', body))).status, 400);
  }
  for (const method of ['DELETE', 'PATCH']) {
    const req = request(method, { name: 'ok' });
    req.url = '/api/lists/not-a-uuid';
    assert.equal((await invoke(item, req)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('method and media type errors are explicit and do not access storage', async () => {
  const calls = database([]);
  for (const handler of [collection, item, reorder]) {
    const result = await invoke(handler, request('HEAD'));
    assert.equal(result.status, 405);
    assert.ok(result.headers.allow);
  }
  for (const [handler, method] of [[collection, 'POST'], [item, 'PATCH'], [reorder, 'PUT']] as const) {
    const req = request(method);
    req.headers['content-type'] = 'text/plain';
    assert.equal((await invoke(handler, req)).status, 415);
  }
  assert.equal(calls.length, 0);
});

test('not found, stale order and nonempty deletion have safe actionable responses', async () => {
  for (const [code, status, method, handler] of [
    ['PT404', 404, 'PATCH', item], ['PT404', 404, 'DELETE', item],
    ['PT409', 409, 'PUT', reorder], ['PT400', 400, 'PUT', reorder], ['23503', 409, 'DELETE', item],
  ] as const) {
    database({ code, message: 'sensitive database detail' }, status);
    const result = await invoke(handler, request(method, method === 'PUT' ? { ids: [id] } : { name: 'ok' }));
    assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
  }
});

test('storage failures and malformed responses fail closed without leaking details', async () => {
  for (const [handler, method, body, result] of [
    [collection, 'GET', undefined, null], [collection, 'GET', undefined, [null]],
    [collection, 'POST', { name: 'ok' }, null], [item, 'DELETE', undefined, {}],
    [collection, 'POST', { name: 'ok' }, []],
    [reorder, 'PUT', { ids: [] }, {}],
  ] as const) {
    database(result);
    assert.equal((await invoke(handler, request(method, body))).status, 503);
  }
  database({ message: 'sensitive', code: 'XX000' }, 500);
  assert.equal((await invoke(collection, request('GET'))).status, 503);
  globalThis.fetch = async () => { throw new Error('test-server-key'); };
  const result = await invoke(collection, request('GET'));
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result).includes('test-server-key'));
  const url = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'http://example.invalid';
  try { assert.equal((await invoke(collection, request('GET'))).status, 503); }
  finally { process.env.SUPABASE_URL = url; }
});
