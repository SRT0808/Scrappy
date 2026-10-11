import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import handler from '../api/baskets/[id].js';
import { COOKIE_NAME, createSession, type ApiRequest } from '../lib/server/auth.js';
import { basketDetail, basketId, productId } from './fixtures/basket-experience.js';
process.env.ACCESS_KEY='test-key';
process.env.SESSION_SECRET='test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL='https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-server-key';
const original=globalThis.fetch;
afterEach(()=>{globalThis.fetch=original;});
function request(method='GET',body?:unknown,query='range=14'):ApiRequest {
  return {method,body,url:`/api/baskets/${basketId}?${query}`,socket:{encrypted:true},headers:{host:'scrappy.example',origin:'https://scrappy.example',
    'content-type':'application/json',cookie:`${COOKIE_NAME}=${createSession()}`}} as unknown as ApiRequest;
}
async function invoke(req:ApiRequest) {
  let body='';const res={statusCode:200,setHeader(){},end(value:string){body=value;}} as unknown as ServerResponse;
  await handler(req,res);return {status:res.statusCode,body:JSON.parse(body)};
}
test('authenticated detail selects its range and validates storage response',async()=>{
  globalThis.fetch=async(url,options)=>{
    assert.ok(String(url).endsWith('/rpc/read_basket_detail'));
    assert.deepEqual(JSON.parse(String(options?.body)),{p_id:basketId,p_days:14});
    return new Response(JSON.stringify(basketDetail));
  };
  assert.equal((await invoke(request())).status,200);
});
test('membership mutations forward version and quantity and re-read the selected range',async()=>{
  const calls:unknown[]=[];
  globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(String(options?.body)));return new Response(JSON.stringify(basketDetail));};
  assert.equal((await invoke(request('PATCH',{product_id:productId,quantity:2,version:2}))).status,200);
  assert.deepEqual(calls,[{p_id:basketId,p_product_id:productId,p_quantity:2,p_version:2},{p_id:basketId,p_days:14}]);
});
test('invalid requests, missing session and cross origin never reach storage',async()=>{
  globalThis.fetch=async()=>{throw new Error('Unexpected storage access');};
  for(const quantity of [0,-1,1.1,2147483648,'2']) assert.equal((await invoke(request('PATCH',{product_id:productId,quantity,version:2}))).status,400);
  for(const query of ['range=1','range=14&range=30','range=14&select=*']) assert.equal((await invoke(request('GET',undefined,query))).status,400);
  const anonymous=request();delete anonymous.headers.cookie;assert.equal((await invoke(anonymous)).status,401);
  const foreign=request('PATCH',{product_id:productId,quantity:2,version:2});foreign.headers.origin='https://other.example';assert.equal((await invoke(foreign)).status,403);
});
test('stale versions and malformed snapshots fail safely',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({code:'PT409',message:'private'}),{status:409});
  const conflict=await invoke(request('PATCH',{product_id:productId,quantity:2,version:2}));
  assert.equal(conflict.status,409);assert.ok(!JSON.stringify(conflict.body).includes('private'));
  globalThis.fetch=async()=>new Response(JSON.stringify({...basketDetail,snapshots:[{...basketDetail.snapshots[0],current_total:'bad'}]}));
  assert.equal((await invoke(request())).status,503);
});
