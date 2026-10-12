import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { createProductHandler } from '../api/products/[id].js';
import basketHandler from '../api/baskets/[id].js';
import listHandler from '../api/lists/[id].js';
import { COOKIE_NAME, createSession, type ApiRequest, type Handler } from '../lib/server/auth.js';
import { basketDetail, basketId, productId } from './fixtures/basket-experience.js';

process.env.ACCESS_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const list = { id: basketId, name: 'Tecnología', emoji: null, position: 0, created_at: '2026-10-08T00:00:00Z' };
const product = { id: productId, url: 'https://shop.pe/product', domain: 'shop.pe', name: 'Monitor', image_url: null,
  currency: 'PEN', reference_price: '100.00', target_type: 'price', target_price: '80.00', target_percent: null,
  last_price: '90.00', status: 'active', last_checked_at: '2026-10-09T12:00:00Z', last_success_at: '2026-10-09T12:00:00Z',
  created_at: '2026-10-08T12:00:00Z', check_interval_hours: 3 };

function request(url: string, method = 'GET', body?: unknown): ApiRequest {
  return { url, method, body, socket: { encrypted: true }, headers: {
    host: 'scrappy.example', origin: 'https://scrappy.example', 'content-type': 'application/json',
    cookie: `${COOKIE_NAME}=${createSession()}`,
  } } as unknown as ApiRequest;
}
async function invoke(handler: Handler, req: ApiRequest) {
  let body = '';
  const res = { statusCode: 200, setHeader() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(body) };
}
// Vercel's createRouteFromPath generates /api/<collection>/[id](.ts)?id=$1.
// Also cover runtimes preserving the public pathname and Vite's URL without the injected query.
function paths(collection: string, id: string) {
  return [`/api/${collection}/[id]?id=${id}`, `/api/${collection}/[id].ts?id=${id}`,
    `/api/${collection}/%5Bid%5D?id=${id}`, `/api/${collection}/${id}?id=${id}`,
    `/api/${collection}/${id}?`, `/api/${collection}/${id}/?`];
}
function withRange(path: string, range: string) {
  return `${path}${path.endsWith('?') ? '' : '&'}range=${range}`;
}

test('product details accept Vercel rewrite destinations and preserve default/explicit ranges', async () => {
  globalThis.fetch = async url => {
    const address = new URL(String(url));
    if (address.pathname.endsWith('/products')) {
      assert.equal(address.searchParams.get('id'), `eq.${productId}`);
      return new Response(JSON.stringify([product]));
    }
    assert.ok(address.pathname.endsWith('/price_checks'));
    assert.equal(address.searchParams.get('product_id'), `eq.${productId}`);
    return new Response('[]');
  };
  for (const path of paths('products', productId)) {
    for (const url of [path, ...['7', '30', '90', 'all'].map(range => withRange(path, range))]) {
      const result = await invoke(createProductHandler(), request(url));
      assert.equal(result.status, 200, url);
      assert.equal(result.body.detail.product.id, productId);
    }
  }
});

test('rewritten product edits, deletion and manual review target the resolved ID', async () => {
  const dispatched: string[] = [];
  const handler = createProductHandler(async id => { dispatched.push(id); });
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).searchParams.get('id'), `eq.${productId}`);
    if (options?.method === 'PATCH') assert.deepEqual(JSON.parse(String(options.body)), { status: 'paused' });
    return new Response(JSON.stringify([product]));
  };
  for (const path of paths('products', productId).slice(0, 2)) {
    assert.equal((await invoke(handler, request(path, 'PATCH', { status: 'paused' }))).status, 200);
    assert.equal((await invoke(handler, request(path, 'DELETE'))).status, 200);
    assert.equal((await invoke(handler, request(path, 'POST', { action: 'review' }))).status, 202);
  }
  assert.deepEqual(dispatched, [productId, productId]);
});

test('basket rewrites retain the ID and selected days including the default', async () => {
  for (const path of paths('baskets', basketId)) {
    for (const range of [undefined, '7', '14', '30', '90', 'all']) {
      globalThis.fetch = async (url, options) => {
        assert.ok(String(url).endsWith('/rpc/read_basket_detail'));
        assert.deepEqual(JSON.parse(String(options?.body)), { p_id: basketId, p_days: range === 'all' ? null : Number(range ?? '30') });
        return new Response(JSON.stringify(basketDetail));
      };
      assert.equal((await invoke(basketHandler, request(range ? withRange(path, range) : path))).status, 200);
    }
  }
});

test('rewritten basket membership changes preserve optimistic version and quantity', async () => {
  const calls: unknown[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify(basketDetail));
  };
  const url = `/api/baskets/[id]?id=${basketId}&range=14`;
  assert.equal((await invoke(basketHandler, request(url, 'PATCH', { product_id: productId, quantity: 2, version: 2 }))).status, 200);
  assert.deepEqual(calls, [{ p_id: basketId, p_product_id: productId, p_quantity: 2, p_version: 2 }, { p_id: basketId, p_days: 14 }]);
});

test('list rewrite destinations support rename, basket configuration and deletion', async () => {
  const calls: unknown[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify(list));
  };
  for (const path of paths('lists', basketId).slice(0, 2)) {
    assert.equal((await invoke(listHandler, request(path, 'PATCH', { name: 'Nuevo' }))).status, 200);
    assert.equal((await invoke(listHandler, request(path, 'PATCH', { basket_budget: 100, basket_currency: 'PEN' }))).status, 200);
    assert.equal((await invoke(listHandler, request(path, 'DELETE'))).status, 200);
  }
  assert.deepEqual(calls, Array.from({ length: 2 }, () => [
    { p_operation: 'rename', p_id: basketId, p_name: 'Nuevo', p_emoji: null, p_set_emoji: false },
    { p_id: basketId, p_budget: 100, p_currency: 'PEN' }, { p_operation: 'delete', p_id: basketId },
  ]).flat());
});

test('ambiguous IDs, invalid paths, repeated filters and unknown query fields never reach storage', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected storage access'); };
  for (const [collection, id, handler, method] of [
    ['products', productId, createProductHandler(), 'GET'], ['baskets', basketId, basketHandler, 'GET'],
    ['lists', basketId, listHandler, 'DELETE'],
  ] as const) {
    const otherId = id === productId ? basketId : productId;
    for (const suffix of ['', '?id=', '?id=invalid', `?id=${id}&id=${id}`, `?id=${id}&id=${otherId}`,
      `?id=${id}&range=7&range=30`, `?id=${id}&select=*`, `?id=${id}&id%5B%5D=${otherId}`]) {
      assert.equal((await invoke(handler, request(`/api/${collection}/[id]${suffix}`, method))).status, 400, suffix);
    }
    for (const path of [`${id}?id=${otherId}`, `invalid?id=${id}`, `invalid/extra?id=${id}`, `%ZZ?id=${id}`, `[id]/extra?id=${id}`]) {
      assert.equal((await invoke(handler, request(`/api/${collection}/${path}`, method))).status, 400, path);
    }
    assert.equal((await invoke(handler, request(`/api/other/[id]?id=${id}`, method))).status, 400);
  }
  for (const [handler, url] of [[createProductHandler(), `/api/products/[id]?id=${productId}&range=14`],
    [basketHandler, `/api/baskets/[id]?id=${basketId}&range=1`], [listHandler, `/api/lists/[id]?id=${basketId}&range=30`]] as const) {
    assert.equal((await invoke(handler, request(url, handler === listHandler ? 'DELETE' : 'GET'))).status, 400);
  }
  assert.equal(calls, 0);
});

test('rewritten routes still enforce session, origin and method before storage access', async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected storage access'); };
  for (const [collection, id, handler] of [['products', productId, createProductHandler()],
    ['baskets', basketId, basketHandler], ['lists', basketId, listHandler]] as const) {
    const url = `/api/${collection}/[id]?id=${id}`;
    const anonymous = request(url, 'PATCH', {}); delete anonymous.headers.cookie;
    assert.equal((await invoke(handler, anonymous)).status, 401);
    const foreign = request(url, 'PATCH', {}); foreign.headers.origin = 'https://evil.example';
    assert.equal((await invoke(handler, foreign)).status, 403);
    assert.equal((await invoke(handler, request(url, 'PUT'))).status, 405);
  }
});
