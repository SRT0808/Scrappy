import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import handler from '../api/products/index.js';
import { COOKIE_NAME, createSession, type ApiRequest } from '../lib/server/auth.js';

process.env.ACCESS_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = '11111111-1111-4111-8111-111111111111';
const product = { id: '22222222-2222-4222-8222-222222222222', list_id: id,
  url: 'https://shop.pe/product', domain: 'shop.pe', name: 'Monitor', image_url: null,
  currency: 'PEN', reference_price: '100.00', target_type: 'percent', target_price: '80.00', target_percent: '20.00', last_price: '90.00',
  status: 'active', last_checked_at: '2026-10-09T12:00:00Z', last_success_at: '2026-10-09T12:00:00Z', created_at: '2026-10-08T12:00:00Z',
  price_checks: [{ checked_at: '2026-10-09T12:00:00Z', price: '90.00', currency: 'PEN' }, { checked_at: '2026-10-08T12:00:00Z', price: 100, currency: 'PEN' }],
};
function request(query = `list_id=${id}`, method = 'GET'): ApiRequest {
  return { method, url: `/api/products?${query}`, socket: { encrypted: true }, headers: {
    host: 'scrappy.example', origin: 'https://scrappy.example', cookie: `${COOKIE_NAME}=${createSession()}`,
  } } as unknown as ApiRequest;
}
async function invoke(req: ApiRequest) {
  let body = '';
  const headers: Record<string, string> = {};
  const res = { statusCode: 200, setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); }, end(value: string) { body = value; } } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, headers, body: JSON.parse(body) };
}
function database(rows: unknown = [product], status = 200) {
  const calls: URL[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(new Headers(options?.headers).get('apikey'), 'test-server-key');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-server-key');
    assert.ok(options?.signal);
    calls.push(new URL(String(url)));
    return new Response(JSON.stringify(rows), { status });
  };
  return calls;
}
test('product listing requires a valid unique session before storage access', async () => {
  const calls = database();
  for (const cookie of ['', `${COOKIE_NAME}=invalid`, `${COOKIE_NAME}=${createSession(1)}`, `${COOKIE_NAME}=${createSession()}; ${COOKIE_NAME}=${createSession()}`]) {
    const req = request(); req.headers.cookie = cookie;
    assert.equal((await invoke(req)).status, 401);
  }
  assert.equal(calls.length, 0);
});
test('invalid, duplicated and injected list filters are rejected before storage access', async () => {
  const calls = database();
  for (const query of ['', 'list_id=invalid', `list_id=${id}&list_id=${id}`, `list_id=${id}&select=*`, `list_id=${id},or(status.eq.active)`]) assert.equal((await invoke(request(query))).status, 400);
  assert.equal((await invoke(request(`list_id=${id}`, 'POST'))).status, 405);
  assert.equal(calls.length, 0);
});
test('reads only the selected list, limits successful history and normalizes money without leaking metadata', async () => {
  const calls = database([{ ...product, private_metadata: 'secret', price_checks: [...product.price_checks, { checked_at: '2026-10-08T00:00:00Z', price: 1, currency: 'USD' }] }]);
  const result = await invoke(request());
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.products[0].last_price, 90);
  assert.deepEqual(result.body.products[0].history.map((point: { price: number }) => point.price), [100, 90]);
  assert.ok(!JSON.stringify(result.body).includes('secret'));
  assert.equal(calls[0].searchParams.get('list_id'), `eq.${id}`);
  assert.equal(calls[0].searchParams.get('price_checks.limit'), '20');
  assert.equal(calls[0].searchParams.get('price_checks.ok'), 'eq.true');
  assert.equal(calls[0].searchParams.get('price_checks.order'), 'checked_at.desc,id.desc');
});
test('empty lists and missing prices remain valid; unsafe image URLs are replaced', async () => {
  database([]); assert.deepEqual((await invoke(request())).body, { products: [] });
  database([{ ...product, currency: null, last_price: null, target_price: null, target_percent: null, reference_price: null, target_type: null,
    image_url: 'javascript:alert(1)', status: 'pending_confirmation', last_checked_at: null, last_success_at: null, price_checks: [] }]);
  const result = await invoke(request());
  assert.equal(result.status, 200);
  assert.equal(result.body.products[0].image_url, null);
});
test('storage errors and malformed responses do not expose private details', async () => {
  for (const rows of [{ error: 'private details' }, [{ ...product, last_price: -1 }], [{ ...product, list_id: product.id }], [{ ...product, url: 'javascript:alert(1)' }]]) {
    database(rows);
    const result = await invoke(request());
    assert.equal(result.status, 503);
    assert.ok(!JSON.stringify(result.body).includes('private'));
  }
  database({ message: 'private details' }, 500);
  assert.equal((await invoke(request())).status, 503);
});
test('continues reading when the storage row cap is smaller than the requested page', async () => {
  const offsets: string[] = [];
  globalThis.fetch = async url => {
    const offset = new URL(String(url)).searchParams.get('offset')!;
    offsets.push(offset);
    return new Response(JSON.stringify([{ ...product, id: offset === '0' ? product.id : '33333333-3333-4333-8333-333333333333' }]), { headers: { 'content-range': `${offset}-${offset}/2` } });
  };
  const result = await invoke(request());
  assert.equal(result.body.products.length, 2);
  assert.deepEqual(offsets, ['0', '1']);
});
