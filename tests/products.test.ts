import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import handler, { createReadingsHandler } from '../api/products/readings.js';
import { COOKIE_NAME, createSession, type ApiRequest } from '../lib/server/auth.js';
import { percentageTarget, productUrl, validConfirmation } from '../lib/product-contract.js';

process.env.ACCESS_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
process.env.GITHUB_TOKEN = 'server-only-token';
process.env.GITHUB_REPO = 'owner/scrappy';
process.env.VERCEL = '1';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = '11111111-1111-4111-8111-111111111111';
const row = { id, url: 'https://shop.pe/product', status: 'queued', result: null, product_id: null, created_at: '2026-10-09T00:00:00Z' };
const result = { name: 'Monitor', price: '100.00', original_price: '120.00', currency: 'PEN', image_url: null, method: 'json_ld', confidence: 0.98, candidates: [], warnings: [] };
const confirmation = { list_id: id, name: ' Monitor ', currency: 'PEN', candidate_index: null, reference_price: '120.00', target_type: 'percent', target_value: '25', check_interval_hours: 6 };

function request(method = 'POST', body: unknown = { action: 'read', url: row.url }): ApiRequest {
  return { method, body, url: `/api/products/readings?id=${id}`, socket: {}, headers: {
    host: 'scrappy.example', origin: 'https://scrappy.example', 'content-type': 'application/json',
    cookie: `${COOKIE_NAME}=${createSession()}`,
  } } as ApiRequest;
}

async function invoke(req: ApiRequest, selectedHandler = handler) {
  let payload = '';
  const headers: Record<string, string> = {};
  const res = { statusCode: 200, setHeader(name: string, value: unknown) { headers[name] = String(value); }, end(value: string) { payload = value; } } as unknown as ServerResponse;
  await selectedHandler(req, res);
  return { status: res.statusCode, body: JSON.parse(payload), headers };
}

function mock(...responses: (Response | Error)[]) {
  const calls: { url: string; body: any; headers: any }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined, headers: options?.headers });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'Unexpected fetch'); return response;
  };
  return calls;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('development dispatch uses the CLI hook only after session, origin and database checks', async () => {
  const dispatched: string[] = [];
  const local = createReadingsHandler(async id => { dispatched.push(id); });
  const calls = mock(json(row));
  const anonymous = request(); delete anonymous.headers.cookie;
  assert.equal((await invoke(anonymous, local)).status, 401);
  const foreign = request(); foreign.headers.origin = 'https://other.example';
  assert.equal((await invoke(foreign, local)).status, 403);
  assert.deepEqual(dispatched, []);
  assert.equal((await invoke(request(), local)).status, 200);
  assert.deepEqual(dispatched, [id]);
  assert.equal(calls.length, 1);
  mock(json({ ...row, status: 'ready', result }));
  assert.equal((await invoke(request(), local)).status, 200);
  assert.deepEqual(dispatched, [id]);
});

test('creates one inactive reading and dispatches only its ID to main', async () => {
  const calls = mock(json(row), new Response(null, { status: 204 }));
  const response = await invoke(request());
  assert.equal(response.status, 200);
  assert.equal(response.body.reading.status, 'queued');
  assert.deepEqual(calls[0].body, { p_id: id, p_url: row.url, p_selector: null });
  assert.deepEqual(calls[1].body, { ref: 'main', inputs: { mode: 'reading', reading_id: id } });
  assert.ok(calls[1].url.endsWith('/check-prices.yml/dispatches'));
  assert.ok(!JSON.stringify(response.body).includes('server-only-token'));
});

test('read replay after a claimed reading never dispatches again', async () => {
  const calls = mock(json({ ...row, status: 'reading' }));
  assert.equal((await invoke(request())).status, 200);
  assert.equal(calls.length, 1);
});

test('dispatch timeout leaves the ID recoverable through GET', async () => {
  mock(json(row), new DOMException('Timeout', 'TimeoutError'));
  assert.equal((await invoke(request())).status, 503);
  const calls = mock(json([row]));
  assert.deepEqual((await invoke(request('GET'))).body.reading, row);
  assert.ok(calls[0].url.includes('product_readings?id=eq.'));
});

test('confirms atomically and returns the same persisted product on replay', async () => {
  const confirmed = { ...row, status: 'confirmed', result, product_id: id };
  const calls = mock(json(confirmed), json(confirmed));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await invoke(request('POST', { action: 'confirm', ...confirmation }));
    assert.equal(response.status, 200); assert.equal(response.body.reading.product_id, id);
  }
  assert.ok(calls.every(call => call.url.endsWith('/rpc/confirm_product_reading')));
  assert.equal(calls[0].body.p_confirmation.name, 'Monitor');
});

test('all actions require session and mutations require same origin', async () => {
  const calls = mock();
  for (const method of ['GET', 'POST']) {
    const req = request(method); delete req.headers.cookie;
    assert.equal((await invoke(req)).status, 401);
  }
  const req = request(); req.headers.origin = 'https://other.example';
  assert.equal((await invoke(req)).status, 403); assert.equal(calls.length, 0);
});

test('rejects unsafe URLs, selectors, IDs, fields and methods without contacting services', async () => {
  const calls = mock();
  for (const url of ['file:///tmp/x', 'https://localhost/x', 'http://127.0.0.1/x', 'https://user:pass@shop.pe/x', 'https://shop.pe:8080/x', 'http://router.local/x']) {
    assert.equal(productUrl(url), null);
    assert.equal((await invoke(request('POST', { action: 'read', url }))).status, 400);
  }
  for (const body of [{ action: 'read', url: row.url, selector: '' }, { action: 'read', url: row.url, selector: 'x'.repeat(501) }, { action: 'read', url: row.url, unknown: true }]) {
    assert.equal((await invoke(request('POST', body))).status, 400);
  }
  const invalidId = request(); invalidId.url += 'x';
  assert.equal((await invoke(invalidId)).status, 400);
  assert.equal((await invoke(request('DELETE'))).status, 405);
  const wrongType = request(); wrongType.headers['content-type'] = 'text/plain';
  assert.equal((await invoke(wrongType)).status, 415); assert.equal(calls.length, 0);
});

test('validates confirmation boundaries and rejects arbitrary prices', async () => {
  assert.equal(percentageTarget('0.05', '50'), '0.03');
  assert.equal(percentageTarget('120.00', '25'), '90.00');
  assert.equal(percentageTarget('9999999999.99', '0.01'), '9998999999.99');
  assert.ok(validConfirmation(confirmation));
  assert.ok(validConfirmation({ ...confirmation, target_value: '100' }));
  assert.ok(validConfirmation({ ...confirmation, target_type: 'price', target_value: '0' }));
  for (const changes of [{ reference_price: '0' }, { target_value: '100.01' }, { target_value: 'NaN' }, { reference_price: '1.001' }, { check_interval_hours: 4 }, { candidate_index: 5 }, { current_price: '1' }, { name: ' ' }, { currency: 'pen' }]) {
    const body: Record<string, unknown> = { ...confirmation, ...changes };
    assert.ok(!validConfirmation(body));
    mock(); assert.equal((await invoke(request('POST', { action: 'confirm', ...body }))).status, 400);
  }
});

test('maps conflicts and missing lists without leaking database contents', async () => {
  for (const [code, status] of [['PT409', 409], ['PT404', 404], ['PT400', 400], ['23503', 404]] as const) {
    mock(json({ code, message: 'private data' }, 400));
    const response = await invoke(request('POST', { action: 'confirm', ...confirmation }));
    assert.equal(response.status, status); assert.ok(!JSON.stringify(response.body).includes('private data'));
  }
});

test('rejects malformed successful readings and missing records', async () => {
  for (const data of [{ ...row, status: 'ready', result: null }, { ...row, status: 'ready', result: { ...result, candidates: [{}] } }]) {
    mock(json([data])); assert.equal((await invoke(request('GET'))).status, 503);
  }
  mock(json([])); assert.equal((await invoke(request('GET'))).status, 404);
});
