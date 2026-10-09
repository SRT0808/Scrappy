import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { createProductHandler, dispatchProduct } from '../api/products/[id].js';
import { historicalStatistics } from '../lib/detail-contract.js';
import { COOKIE_NAME, createSession, type ApiRequest } from '../lib/server/auth.js';

process.env.ACCESS_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = '22222222-2222-4222-8222-222222222222';
const listId = '11111111-1111-4111-8111-111111111111';
const product = { id, list_id: listId, url: 'https://shop.pe/product', domain: 'shop.pe', name: 'Monitor', image_url: null,
  currency: 'PEN', reference_price: '100.00', target_type: 'percent', target_price: '80.00', target_percent: '20.00', last_price: '90.00',
  status: 'active', last_checked_at: '2026-10-09T12:00:00Z', last_success_at: '2026-10-09T12:00:00Z', created_at: '2026-10-08T12:00:00Z', check_interval_hours: 3 };
function request(method = 'GET', body?: unknown, query = 'range=all'): ApiRequest {
  return { method, body, url: `/api/products/${id}?${query}`, socket: { encrypted: true }, headers: {
    host: 'scrappy.example', origin: 'https://scrappy.example', 'content-type': 'application/json', cookie: `${COOKIE_NAME}=${createSession()}`,
  } } as unknown as ApiRequest;
}
async function invoke(req = request(), dispatch = async (_id: string) => {}) {
  let body = '';
  const res = { statusCode: 200, setHeader() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
  await createProductHandler(dispatch)(req, res);
  return { status: res.statusCode, body: JSON.parse(body) };
}
function mock(checks: unknown[] = [], row: unknown = product, cap = 1000) {
  const calls: { url: URL; options?: RequestInit }[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(new Headers(options?.headers).get('apikey'), 'test-server-key');
    const address = new URL(String(url)); calls.push({ url: address, options });
    if (address.pathname.endsWith('/products')) return new Response(JSON.stringify(row ? [row] : []));
    assert.equal(address.searchParams.get('product_id'), `eq.${id}`);
    const offset = Number(address.searchParams.get('offset'));
    return new Response(JSON.stringify(checks.slice(offset, offset + cap)), { headers: { 'content-range': `${offset}-${offset + cap - 1}/${checks.length}` } });
  };
  return calls;
}
function check(index: number, price: number | null, daysAgo = 0, extra = {}) {
  return { id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, checked_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    price: price === null ? null : String(price), currency: 'PEN', ok: price !== null, method: 'json_ld', error_code: null, ...extra };
}

test('rejects missing sessions, foreign origins and malformed filters before database access', async () => {
  const calls = mock();
  const anonymous = request(); anonymous.headers.cookie = '';
  assert.equal((await invoke(anonymous)).status, 401);
  const cross = request('PATCH', { status: 'paused' }); cross.headers.origin = 'https://evil.example';
  assert.equal((await invoke(cross)).status, 403);
  for (const query of ['range=14', 'range=7&range=30', 'select=*', 'range=all&or=secret']) assert.equal((await invoke(request('GET', undefined, query))).status, 400);
  const invalid = request(); invalid.url = '/api/products/invalid'; assert.equal((await invoke(invalid)).status, 400);
  assert.equal(calls.length, 0);
});
test('complete paginated history excludes failed and foreign currency prices; stats use all history', async () => {
  const checks = [check(1, 120, 100), check(2, null, 50, { error_code: 'blocked' }), check(3, 1, 40, { currency: 'USD' }),
    ...Array.from({ length: 24 }, (_, i) => check(i + 4, 90, 1))];
  const calls = mock(checks, { ...product, private_metadata: 'secret' }, 2);
  const result = await invoke(request('GET', undefined, 'range=7'));
  assert.equal(result.status, 200);
  const d = result.body.detail;
  assert.equal(d.history.length, 24); assert.equal(d.product.history.length, 20); assert.equal(d.reviews.length, 20);
  assert.deepEqual(d.statistics, { count: 25, min: 90, max: 120, average: 91.2, discount_change: 30 });
  assert.equal(calls.length, 15); assert.equal(calls.at(-1)!.url.searchParams.get('offset'), '26');
  assert.ok(!JSON.stringify(d).includes('secret'));
});
test('ranges, empty statistics and zero reference have defined behavior', async () => {
  for (const [range, length] of [['7', 1], ['30', 2], ['90', 3], ['all', 4]]) {
    mock([check(1, 120, 100), check(2, 110, 50), check(3, 100, 20), check(4, 90, 1)]);
    const result = await invoke(request('GET', undefined, `range=${range}`));
    assert.equal(result.body.detail.history.length, length); assert.equal(result.body.detail.statistics.count, 4);
  }
  mock(); assert.equal((await invoke()).body.detail.statistics.average, null);
  assert.equal(historicalStatistics([{ price: 0, currency: 'PEN', checked_at: new Date().toISOString() }], 0).discount_change, null);
});
test('edits only allowed fields with exact percentage math and preserves alert state', async () => {
  const calls = mock();
  const edit = { name: ' Monitor nuevo ', list_id: listId, reference_price: '123.45', target_type: 'percent', target_value: '12.34', check_interval_hours: 6 };
  assert.equal((await invoke(request('PATCH', edit))).status, 200);
  const update = JSON.parse(String(calls[0].options?.body));
  assert.deepEqual(update, { name: 'Monitor nuevo', list_id: listId, reference_price: '123.45', target_type: 'percent', target_price: '108.22', target_percent: '12.34', check_interval_hours: 6 });
  assert.equal(calls[0].url.searchParams.get('status'), 'neq.pending_confirmation');
  for (const invalid of [{ ...edit, alert_state: 'armed' }, { ...edit, reference_price: '0' }, { ...edit, target_value: '101' }, { ...edit, check_interval_hours: 1 }, { status: 'pending_confirmation' }])
    assert.equal((await invoke(request('PATCH', invalid))).status, 400);
  const content = request('PATCH', edit); delete content.headers['content-type']; assert.equal((await invoke(content)).status, 415);
  assert.equal(calls.length, 1);
});
test('pause, resume and delete persist only their intended changes and missing products return 404', async () => {
  const calls = mock();
  assert.equal((await invoke(request('PATCH', { status: 'paused' }))).status, 200);
  assert.equal((await invoke(request('PATCH', { status: 'active' }))).status, 200);
  assert.deepEqual(calls.slice(0, 2).map(c => JSON.parse(String(c.options?.body))), [{ status: 'paused' }, { status: 'active' }]);
  assert.deepEqual((await invoke(request('DELETE'))).body, { deleted: true });
  assert.equal(calls[2].options?.method, 'DELETE');
  mock([], null);
  for (const method of ['GET', 'DELETE', 'PATCH', 'POST']) assert.equal((await invoke(request(method, method === 'PATCH' ? { status: 'paused' } : { action: 'review' }))).status, 404);
});
test('review dispatches once, rejects paused products, and conceals storage or dispatch failures', async () => {
  mock(); const ids: string[] = [];
  assert.equal((await invoke(request('POST', { action: 'review' }), async id => { ids.push(id); })).status, 202);
  assert.deepEqual(ids, [id]);
  assert.equal((await invoke(request('POST', { action: 'unknown' }))).status, 400);
  mock([], { ...product, status: 'paused' });
  assert.equal((await invoke(request('POST', { action: 'review' }), async id => { ids.push(id); })).status, 409);
  assert.equal(ids.length, 1);
  mock(); assert.equal((await invoke(request('POST', { action: 'review' }), async () => { throw new Error('secret'); })).status, 503);
  mock([{ ...check(1, 90), price: '-1' }]); assert.equal((await invoke()).status, 503);
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'private storage failure' }), { status: 500 });
  assert.deepEqual((await invoke()).body, { error: 'Servicio temporalmente no disponible.' });
});
test('production manual review uses the existing workflow on main without exposing credentials', async () => {
  process.env.GITHUB_TOKEN = 'test-token'; process.env.GITHUB_REPO = 'user/scrappy';
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.github.com/repos/user/scrappy/actions/workflows/check-prices.yml/dispatches');
    assert.deepEqual(JSON.parse(String(options?.body)), { ref: 'main', inputs: { mode: 'product', product_id: id } });
    return new Response(null, { status: 204 });
  };
  try { await dispatchProduct(id); } finally { delete process.env.GITHUB_TOKEN; delete process.env.GITHUB_REPO; }
});
