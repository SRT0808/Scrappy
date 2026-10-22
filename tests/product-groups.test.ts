import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import type {ServerResponse} from 'node:http';
import handler from '../api/product-groups.js';
import {COOKIE_NAME,createSession,type ApiRequest} from '../lib/server/auth.js';
import {groupEditTarget,validGroupEdit} from '../lib/group-contract.js';
import {groupFixture,offerId} from './fixtures/group-ui.js';
process.env.ACCESS_KEY='test-key';process.env.SESSION_SECRET='test-secret-with-at-least-32-bytes';
process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-server-key';
const original=globalThis.fetch;afterEach(()=>{globalThis.fetch=original;});
const id='11111111-1111-4111-8111-111111111111';
const edit={name:'Cleanser',reference_price:'69.90',target_type:'percent' as const,target_value:'40',image_product_id:id};
async function invoke(method='GET',body?:unknown,query='',headers:Record<string,string>={}) {
 const req={method,body,url:`/api/product-groups${query}`,socket:{encrypted:true},headers:{host:'scrappy.example',origin:'https://scrappy.example','content-type':'application/json',cookie:`${COOKIE_NAME}=${createSession()}`,...headers}} as unknown as ApiRequest;
 let text='';const res={statusCode:200,setHeader(){},end(v:string){text=v;}} as unknown as ServerResponse;
 await handler(req,res);return {status:res.statusCode,body:JSON.parse(text)};
}
test('amount and percentage mode preserve the chosen input when reference changes',()=>{
 assert.ok(validGroupEdit(edit));assert.ok(Math.abs(groupEditTarget(edit)-41.94)<0.000001);
 assert.equal(groupEditTarget({...edit,reference_price:'70'}),42);
 assert.equal(groupEditTarget({...edit,target_type:'price',target_value:'40',reference_price:'70'}),40);
 assert.equal(validGroupEdit({...edit,target_value:'101'}),false);
 assert.equal(validGroupEdit({...edit,reference_price:'NaN'}),false);
});
test('rejects invalid ids, mutations and overposted fields before database access',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json([]);};
 for(const q of ['?id=bad','?id='+id+'&id='+id,'?select=*'])assert.equal((await invoke('GET',undefined,q)).status,400);
 for(const body of [{action:'create',data:{...edit,same_product:false,product_ids:[id,id]}},{action:'pause',version:1,data:{paused:'true'}},{action:'dissolve',version:1,data:{alert_state:'armed'}}])assert.equal((await invoke('POST',body,'?id='+id)).status,400);
 assert.equal(calls,0);
});
test('authenticated list uses only a server RPC and fails closed on invalid response',async()=>{
 globalThis.fetch=async(url,options)=>{assert.match(String(url),/rpc\/read_product_groups$/);assert.equal(new Headers(options?.headers).get('apikey'),'test-server-key');assert.deepEqual(JSON.parse(String(options?.body)),{p_id:null,p_history:false});return Response.json([]);};
 assert.deepEqual((await invoke()).body,{groups:[]});
 globalThis.fetch=async()=>Response.json([{id}]);assert.equal((await invoke()).status,503);
});
test('authentication, origin and methods reject requests before storage access',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json([]);};
 assert.equal((await invoke('GET',undefined,'',{cookie:''})).status,401);
 assert.equal((await invoke('POST',{},'?id='+id,{origin:'https://attacker.example'})).status,403);
 assert.equal((await invoke('DELETE')).status,405);
 assert.equal(calls,0);
});
test('valid membership mutation forwards the version and explicit identity to one RPC',async()=>{
 const g=groupFixture();let calls=0;
 globalThis.fetch=async(url,options)=>{
  calls++;assert.match(String(url),/rpc\/mutate_product_group$/);
  assert.deepEqual(JSON.parse(String(options?.body)),{p_id:id,p_version:1,p_action:'add',p_body:{product_id:offerId(3),same_product:true}});
  return Response.json(g);
 };
 assert.equal((await invoke('POST',{action:'add',version:1,data:{product_id:offerId(3),same_product:true}},'?id='+id)).status,200);
 assert.equal(calls,1);
 globalThis.fetch=async()=>Response.json({code:'40001'},{status:409});
 assert.equal((await invoke('POST',{action:'pause',version:1,data:{paused:true}},'?id='+id)).status,409);
});
