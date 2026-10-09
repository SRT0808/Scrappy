import assert from 'node:assert/strict';
import { request } from 'node:https';
import { connect } from 'node:http2';
import { test } from 'node:test';
import { createServer } from 'vite';

test('local HTTPS serves the web and original API handlers on the same origin', async () => {
  process.env.ACCESS_KEY = 'local-test-key';
  process.env.SESSION_SECRET = 'local-test-secret-with-at-least-32-bytes';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-server-key';
  delete process.env.VERCEL;
  const originalFetch = globalThis.fetch;
  const attempts: unknown[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(new Headers(options?.headers).get('apikey'), 'local-test-server-key');
    if (String(url).endsWith('/rpc/record_login_attempt')) {
      attempts.push(JSON.parse(String(options?.body)));
      return new Response('0');
    }
    assert.ok(/^https:\/\/example.supabase.co\/rest\/v1\/(lists|products)\?/.test(String(url)));
    return new Response('[]');
  };
  const server = await createServer({ server: { port: 0 } });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address === 'object');
    const origin = `https://localhost:${address.port}`;
    const send = (path: string, method = 'GET', body?: string, cookie?: string, requestOrigin = origin) =>
      new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = request(`${origin}${path}`, {
          method, rejectUnauthorized: false,
          headers: { origin: requestOrigin, 'content-type': 'application/json',
            'x-vercel-forwarded-for': '192.0.2.123', ...(cookie ? { cookie } : {}) },
        }, res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
        });
        req.on('error', reject);
        req.end(body);
      });
    const web = await send('/');
    assert.equal(web.status, 200);
    assert.match(web.headers['content-type']!, /text\/html/);
    assert.ok(!web.body.includes(process.env.SESSION_SECRET!));
    const anonymous = await send('/api/session');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers['content-type']!, /application\/json/);
    assert.equal((await send('/api/unknown')).status, 404);
    assert.equal((await send('/api/login', 'POST', '{')).status, 400);
    assert.equal((await send('/api/login', 'POST', JSON.stringify({ key: 'x'.repeat(1024 * 1024) }))).status, 413);
    assert.equal((await send('/api/login', 'POST', '{"key":"local-test-key"}', undefined, 'https://evil.example')).status, 403);
    assert.equal((await send('/api/login', 'POST', '{"key":"wrong"}')).status, 401);
    const login = await send('/api/login', 'POST', '{"key":"local-test-key"}');
    assert.equal(login.status, 200);
    const setCookie = login.headers['set-cookie']![0];
    assert.match(setCookie, /^__Host-scrappy_session=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(flag));
    const cookie = setCookie.split(';')[0];
    const session = await send('/api/session', 'GET', undefined, cookie);
    assert.equal(session.status, 200);
    assert.deepEqual(JSON.parse(session.body), { authenticated: true });
    assert.equal(session.headers['cache-control'], 'no-store');
    assert.equal((await send('/api/lists', 'GET', undefined, cookie)).status, 200);
    assert.equal((await send('/api/products?list_id=11111111-1111-4111-8111-111111111111', 'GET', undefined, cookie)).status, 200);
    assert.equal((await send('/api/lists/not-a-uuid', 'PATCH', '{}', cookie)).status, 400);
    assert.equal((await send('/api/lists/reorder', 'POST', '{}', cookie)).status, 405);
    assert.equal((await send('/api/products/readings?id=invalid', 'GET', undefined, cookie)).status, 400);
    assert.equal((await send('/api/products/invalid', 'GET', undefined, cookie)).status, 400);
    assert.equal((await send('/api/products/11111111-1111-4111-8111-111111111111?range=all', 'GET', undefined, cookie)).status, 404);
    const logout = await send('/api/logout', 'POST', '{}', cookie);
    assert.equal(logout.status, 200);
    assert.match(logout.headers['set-cookie']![0], /Max-Age=0/);
    const client = connect(origin, { rejectUnauthorized: false });
    try {
      const sendHttp2 = (path: string, method = 'GET', body?: string, cookie?: string, requestOrigin = origin) =>
        new Promise<{ status: number; headers: import('node:http2').IncomingHttpHeaders; body: string }>((resolve, reject) => {
          const stream = client.request({ ':path': path, ':method': method, origin: requestOrigin,
            'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) });
          let headers: import('node:http2').IncomingHttpHeaders;
          let text = '';
          stream.on('response', value => { headers = value; });
          stream.setEncoding('utf8');
          stream.on('data', chunk => { text += chunk; });
          stream.on('error', reject);
          stream.on('end', () => resolve({ status: Number(headers[':status']), headers, body: text }));
          stream.end(body);
        });
      assert.equal((await sendHttp2('/api/login', 'POST', '{"key":"local-test-key"}', undefined, 'https://evil.example')).status, 403);
      const h2Login = await sendHttp2('/api/login', 'POST', '{"key":"local-test-key"}');
      assert.equal(h2Login.status, 200);
      assert.deepEqual(JSON.parse(h2Login.body), { authenticated: true });
      const h2Cookie = h2Login.headers['set-cookie']![0].split(';')[0];
      assert.equal((await sendHttp2('/api/session', 'GET', undefined, h2Cookie)).status, 200);
      assert.equal((await sendHttp2('/api/lists', 'GET', undefined, h2Cookie)).status, 200);
      assert.equal((await sendHttp2('/api/products?list_id=11111111-1111-4111-8111-111111111111', 'GET', undefined, h2Cookie)).status, 200);
      assert.equal((await sendHttp2('/api/logout', 'POST', '{}', h2Cookie)).status, 200);
    } finally {
      client.close();
    }
    assert.equal(attempts.length, 3);
    for (const attempt of attempts) {
      assert.notEqual((attempt as { p_ip: string }).p_ip, '192.0.2.123');
    }
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});
