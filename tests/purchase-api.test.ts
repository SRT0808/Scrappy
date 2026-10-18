import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import handler from '../api/baskets/[id]/purchases.js';
import { COOKIE_NAME, createSession, type ApiRequest } from '../lib/server/auth.js';

process.env.ACCESS_KEY = 'test-key';
process.env.SESSION_SECRET = 'test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
process.env.VERCEL = '1';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = '00000000-0000-4000-8000-000000000001';
const path = `/api/baskets/${id}/purchases`;
const configuration = { schema_version: 2, version: '2' };
const envelope = { schema_version: 2, list_id: id, version: '1', mode: 'alternatives', configuration,
  latest_evaluation: null, stale_reason: 'dirty', events: [], has_more: false };
const publication = { schema_version: 2, expected_version: '1', configuration: {} };
function request(method = 'GET', body?: unknown, url = path): ApiRequest {
  return { method, url, body, socket: {}, headers: { host: 'scrappy.example', origin: 'https://scrappy.example',
    'content-type': 'application/json', cookie: `${COOKIE_NAME}=${createSession()}` } } as ApiRequest;
}
async function invoke(req: ApiRequest) {
  let body = ''; const headers: Record<string, string> = {};
  const res = { statusCode: 200, setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
    end(v: string) { body = v; } } as unknown as ServerResponse;
  await handler(req, res);
  return { status: res.statusCode, headers, body: JSON.parse(body) };
}
function database(result: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-server-key');
    assert.equal(new Headers(options.headers).get('apikey'), 'test-server-key');
    assert.ok(options.signal);
    calls.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return new Response(JSON.stringify(result), { status });
  };
  return calls;
}
test('GET and PUT require unique live sessions; mutation rejects missing/foreign origin', async () => {
  const calls = database(envelope);
  for (const method of ['GET', 'PUT']) for (const cookie of ['', 'bad', `${COOKIE_NAME}=${createSession(1)}`,
    `${COOKIE_NAME}=${createSession()}; ${COOKIE_NAME}=${createSession()}`]) {
    const req = request(method, publication); req.headers.cookie = cookie;
    assert.equal((await invoke(req)).status, 401);
  }
  for (const origin of [undefined, 'https://evil.test']) {
    const req = request('PUT', publication); req.headers.origin = origin;
    assert.equal((await invoke(req)).status, 403);
  }
  const req = request('PUT', publication); req.headers['sec-fetch-site'] = 'same-site';
  assert.equal((await invoke(req)).status, 403);
  assert.equal(calls.length, 0);
});
test('public and rewritten nested paths use a bounded single read and no cache', async () => {
  const calls = database(envelope);
  for (const url of [path, path+'/', path+'?page=1', `/api/baskets/[id]/purchases?id=${id}`,
    `/api/baskets/%5Bid%5D/purchases.ts?id=${id}`, path+`?id=${id}`]) {
    // Vercel may append .ts to the handler filename.
    const result = await invoke(request('GET', undefined, url));
    assert.equal(result.status, 200, url);
    assert.deepEqual(result.body, envelope);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.ok(calls.every(c => c.url.endsWith('/rpc/read_purchase_configuration')));
  assert.deepEqual(calls[2].body, { p_id: id, p_page: 1 });
});
test('invalid routes, queries, versions, extra fields and bodies do not reach storage', async () => {
  const calls = database(envelope);
  for (const url of [path+'?page=-1',path+'?page=10001',path+'?page=1&page=2',path+'?other=x',
    path+'?id=bad', path.replace(id,'bad'), path+`?id=${id}&id=${id}`,
    path+`?id=00000000-0000-4000-8000-000000000002`]) assert.equal((await invoke(request('GET',undefined,url))).status,400);
  for (const body of [null, [], {}, {...publication,mode:'alternatives'}, {...publication,schema_version:1},
    {...publication,expected_version:1}, ...['0','01','-1','1e2','9223372036854775808'].map(expected_version=>({...publication,expected_version})),
    {...publication,configuration:[]}, {...publication,configuration:null}]) assert.equal((await invoke(request('PUT',body))).status,400);
  assert.equal((await invoke(request('PUT',publication,path+'?page=0'))).status,400);
  assert.equal((await invoke(request('POST',publication))).status,400);
  const req = request('PUT',publication); req.headers['content-type']='text/plain';
  assert.equal((await invoke(req)).status,415);
  assert.equal((await invoke(request('PUT',{...publication,configuration:{value:'x'.repeat(262144)}}))).status,413);
  assert.equal(calls.length,0);
});
test('CAS keeps exact bigint strings and sends only the complete configuration once', async () => {
  const calls = database({...configuration,version:'9007199254740994'});
  const result = await invoke(request('PUT',{...publication,expected_version:'9007199254740993'}));
  assert.equal(result.status,200);
  assert.deepEqual(calls,[{url:'https://example.supabase.co/rest/v1/rpc/save_purchase_configuration',body:{p_id:id,p_expected_version:'9007199254740993',p_configuration:{}}}]);
});
test('SQL errors are sanitized; conflicts, missing resources and invalid graphs retain status without retry', async () => {
  for (const [code,status] of [['PT400',400],['PT404',404],['PT409',409],['40001',409],['40P01',409],['42501',503]]) {
    const calls=database({code,message:'private SQL secret'},400);
    const result=await invoke(request('PUT',publication));
    assert.equal(result.status,status); assert.equal(calls.length,1);
    assert.ok(!JSON.stringify(result.body).includes('private'));
  }
});
test('lost responses and malformed success fail closed without replaying the write', async () => {
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('response lost');};
  assert.equal((await invoke(request('PUT',publication))).status,503); assert.equal(calls,1);
  database({...configuration,version:'1'});
  assert.equal((await invoke(request('PUT',publication))).status,503);
  database({});assert.equal((await invoke(request())).status,503);
});

const activation = { ...publication, request_id: '00000000-0000-4000-8000-000000000099', token: 'a'.repeat(64) };
test('activation uses session/origin protection and validates every explicit request field', async () => {
  const calls = database({});
  const req = request('POST', activation); req.headers.cookie = '';
  assert.equal((await invoke(req)).status, 401);
  const foreign = request('POST', activation); foreign.headers.origin = 'https://evil.test';
  assert.equal((await invoke(foreign)).status, 403);
  for (const change of [{ request_id: 'bad' }, { token: 'short' }, { expected_version: 1 }, { extra: true }])
    assert.equal((await invoke(request('POST', { ...activation, ...change }))).status, 400);
  for (const query of ['?preview=0','?preview=1&page=0','?request_id=bad','?preview=1&request_id='+id])
    assert.equal((await invoke(request('GET', undefined, path+query))).status, 400);
  assert.equal(calls.length, 0);
});
test('activation preview and durable readback support public and rewritten routes', async () => {
  const preview = { schema_version: 2, list_id: id, version: '1', token: activation.token, configuration: {} };
  let calls = database(preview);
  for (const url of [path+'?preview=1', `/api/baskets/[id]/purchases?id=${id}&preview=1`]) {
    assert.deepEqual((await invoke(request('GET', undefined, url))).body, preview);
  }
  assert.ok(calls.every(c => c.url.endsWith('/rpc/preview_purchase_activation')));
  calls = database({ schema_version: 2, list_id: id, request_id: activation.request_id, receipt: null });
  assert.equal((await invoke(request('GET',undefined,path+'?request_id='+activation.request_id))).status, 200);
  assert.deepEqual(calls[0].body, { p_id: id, p_request_id: activation.request_id });
});
test('activation validates the receipt and never retries an ambiguous mutation', async () => {
  const receipt = { schema_version: 2, list_id: id, request_id: activation.request_id, previous_version: '1', version: '2', configuration };
  let calls = database(receipt);
  assert.deepEqual((await invoke(request('POST', activation))).body, receipt);
  assert.ok(calls[0].url.endsWith('/rpc/activate_purchase_configuration'));
  assert.deepEqual(calls[0].body, { p_id: id, p_expected_version: '1', p_request_id: activation.request_id, p_token: activation.token, p_configuration: {} });
  calls = database({ ...receipt, request_id: id });
  assert.equal((await invoke(request('POST', activation))).status, 503); assert.equal(calls.length, 1);
  let attempts = 0; globalThis.fetch = async () => { attempts++; throw new Error('Lost response'); };
  assert.equal((await invoke(request('POST', activation))).status, 503); assert.equal(attempts, 1);
});
