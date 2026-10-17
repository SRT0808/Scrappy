import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import handler from '../.scrappy/api-build/api/baskets/[id]/purchases.js';
import { COOKIE_NAME, createSession } from '../.scrappy/api-build/lib/server/auth.js';
import { mutatePurchaseSources } from '../.scrappy/api-build/lib/server/purchase-persistence.js';

export async function runPurchaseApiCases(h) {
 const {admin,connect,value,row,list,product,md5,literal,run,args,capture,evaluate,commit}=h;
 let cases=0; const test=async(name,work)=>{await work();cases++;console.log('PASS purchase API: '+name);};
 const up=resolve('supabase/migrations/20261016050000_purchase_api.sql');
 const down=resolve('supabase/rollback/20261016050000_purchase_api.sql');
 // Match the protocol fixture's deterministic Lima day; no production clock hook.
 const {readFile,writeFile}=await import('node:fs/promises');
 const fixture=resolve('.scrappy','purchase-api-fixture-'+process.pid+'.sql');
 await writeFile(fixture,(await readFile(up,'utf8')).replaceAll('statement_timestamp()','public.purchase_test_now()'));
 const need=md5('api-need'), offer=md5('api-offer'), alt=md5('api-alt');
 const config=()=>({schema_version:2,currency:'PEN',budget:'100.00',budget_enabled:true,winner_enabled:true,minimum_savings:'0.50',
   needs:[{id:need,name:'Agua',required_quantity:'1',unit:'unit',position:0,allow_surplus:false}],
   offers:[{id:offer,product_id:product(1),max_purchase_units:null,coverage:[{need_id:need,quantity:'1'}],extras:[]}],
   alternatives:[{id:alt,name:'Una botella',position:0,scope:[need],items:[{offer_id:offer,purchase_units:1}]}],pins:[],reference:[alt]});
 process.env.ACCESS_KEY='api-local-key';process.env.SESSION_SECRET='api-local-secret-with-at-least-32-bytes';
 process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';process.env.VERCEL='1';
 const originalFetch=globalThis.fetch;
 let rpcCalls=0,loseResponse=false;
 globalThis.fetch=async(url,options)=>{
   rpcCalls++;
   const name=new URL(String(url)).pathname.split('/').at(-1), b=JSON.parse(options.body);
   assert.ok(['read_purchase_configuration','save_purchase_configuration'].includes(name));
   const db=await connect();await db.query('set role service_role');
   try {
     await db.query('begin isolation level serializable');
     const result=await value(name==='read_purchase_configuration'
       ? `select public.read_purchase_configuration(${literal(b.p_id)},${Number(b.p_page)})`
       : `select public.save_purchase_configuration(${literal(b.p_id)},${literal(b.p_expected_version)}::bigint,${literal(JSON.stringify(b.p_configuration))}::jsonb)`,db);
     await db.query('commit');
     if(loseResponse){loseResponse=false;throw new Error('response lost after commit');}
     return new Response(JSON.stringify(result));
   }catch(error){if(error.code)return new Response(JSON.stringify({code:error.code}),{status:400});throw error;}
   finally{await db.close();}
 };
 const invoke=async(method='GET',body,id=list(1),query='')=>{
   let text='';const res={statusCode:200,setHeader(){},end(s){text=s;}};
   await handler({method,url:`/api/baskets/${id}/purchases${query}`,body,socket:{},headers:{host:'fixture.invalid',origin:'https://fixture.invalid',
     'content-type':'application/json',cookie:`${COOKIE_NAME}=${createSession()}`}},res);
   return {status:res.statusCode,body:JSON.parse(text)};
 };
 const publish=async(expected_version,configuration=config(),id=list(1))=>{
   expected_version ??= String((await row(1)).configuration_version);
   return invoke('PUT',{schema_version:2,expected_version,configuration},id);
 };
 const read=async(id=list(1),query='')=>{const r=await invoke('GET',undefined,id,query);assert.equal(r.status,200);return r.body;};
 const counts=()=>value(`select jsonb_build_object('checks',(select count(*) from price_checks),'events',(select count(*) from purchase_events),
   'deliveries',(select count(*) from purchase_deliveries),'evaluations',(select count(*) from purchase_evaluations))`);
 try {
 await test('migration reverses without data changes; only service may execute; read is stable',async()=>{
   const before=await counts();run('psql',[...args,'-f',fixture]);run('psql',[...args,'-f',down]);run('psql',[...args,'-f',fixture]);
   assert.deepEqual(await counts(),before);
   assert.equal(await value("select to_jsonb(provolatile) from pg_proc where oid='public.read_purchase_configuration(uuid,integer)'::regprocedure"),'s');
   for(const role of ['anon','authenticated']) {
     const db=await connect();await db.query(`set role ${role}`);
     await assert.rejects(db.query(`select public.read_purchase_configuration('${list(1)}')`),e=>e.code==='42501');
     assert.equal(await value(`select to_jsonb(has_table_privilege('${role}','public.purchase_deliveries','select'))`),false);
   }
   const db=await connect();await db.query('set role service_role');
   await assert.rejects(db.query(`select public.read_purchase_configuration('${list(1)}',-1)`),e=>e.code==='PT400');
 });
 await test('authenticated full publication and read preserve canonical decimals and version',async()=>{
   const before=await counts(),v=String((await row(1)).configuration_version);
   const saved=await publish(v);assert.equal(saved.status,200);
   const current=await read();assert.deepEqual(current.configuration,saved.body.configuration);
   assert.equal(current.version,(BigInt(v)+1n).toString());assert.equal(current.latest_evaluation,null);assert.equal(current.stale_reason,'dirty');
   assert.equal(current.configuration.needs[0].required_quantity,'1.000000');assert.deepEqual(await counts(),before);
 });
 await test('invalid graph and legacy cannot publish; missing basket returns 404',async()=>{
   const before=await read(); const invalid=config();invalid.offers[0].coverage[0].need_id=md5('missing');
   assert.equal((await publish(before.version,invalid)).status,400);assert.deepEqual(await read(),before);
   const legacy=await read(list(5));assert.equal(legacy.mode,'legacy');assert.equal(legacy.configuration,null);assert.equal(legacy.latest_evaluation,null);
   assert.equal((await publish(legacy.version,config(),list(5))).status,409);assert.equal((await read(list(5))).mode,'legacy');
   assert.equal((await invoke('GET',undefined,md5('missing'))).status,404);
 });
 await test('concurrent CAS publishes exactly once; lost committed response reconciles by GET',async()=>{
   const v=(await read()).version;
   const results=await Promise.all([publish(v),publish(v)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
   assert.equal((await read()).version,(BigInt(v)+1n).toString());
   const next=(await read()).version;loseResponse=true;const n=rpcCalls;
   assert.equal((await publish(next)).status,503);assert.equal(rpcCalls,n+1);
   assert.equal((await read()).version,(BigInt(next)+1n).toString());assert.equal((await publish(next)).status,409);
 });
 await test('authoritative results disappear on source change, publication and Lima day rollover',async()=>{
   await commit(evaluate(await capture()));let current=await read();assert.ok(current.latest_evaluation);
   assert.equal(current.latest_evaluation.snapshot.configuration_version,current.version);
   assert.equal(current.latest_evaluation.snapshot.result.effective.total,'10.00');
   await admin.query("update fixture_clock set at_time='2026-10-17 05:01Z'");
   assert.equal((await read()).latest_evaluation,null);assert.equal((await read()).stale_reason,'date');
   await admin.query("update fixture_clock set at_time='2026-10-16 12:30Z'");
   await mutatePurchaseSources(admin,async()=>{await admin.query(`update products set last_price=11 where id='${product(1)}'`);},[product(1)]);
   assert.equal((await read()).latest_evaluation,null);assert.equal((await read()).stale_reason,'dirty');
   await commit(evaluate(await capture()));assert.ok((await read()).latest_evaluation);
   await publish();assert.equal((await read()).latest_evaluation,null);
 });
 await test('receipts retain per-channel states and historical versions; deterministic bounded pages are read-only',async()=>{
   await commit(evaluate(await capture()));const v=(await read()).version;
   const evaluation=(await read()).latest_evaluation.evaluation_id;
   await admin.query(`insert into purchase_events(list_id,version,evaluation_id,transition_number,reasons,payload)
     select '${list(1)}',${v},'${evaluation}',100+n,'winner','{}' from generate_series(1,22)n;
     insert into purchase_deliveries(event_id,channel,status,receipt)
     select id,c,case when c='ntfy' then 'ambiguous' else 'failed' end,jsonb_build_object('status',case when c='ntfy' then 'ambiguous' else 'failed' end)
     from purchase_events cross join unnest(array['ntfy','email'])c where list_id='${list(1)}' and transition_number>100;`);
   const before=await counts();const first=await read(),second=await read(list(1),'?page=1');
   assert.equal(first.events.length,20);assert.equal(first.has_more,true);assert.equal(second.has_more,false);
   assert.ok(second.events.length>=2);assert.equal(new Set([...first.events,...second.events].map(e=>e.id)).size,first.events.length+second.events.length);
   assert.equal(first.events[0].transition_number,'122');assert.deepEqual(first.events[0].deliveries.map(d=>d.status),['failed','ambiguous']);
   assert.deepEqual((await read(list(2))).events,[]);assert.deepEqual((await read(list(1),'?page=10000')).events,[]);
   await publish();const historical=await read();assert.equal(historical.events[0].version,v);assert.equal(historical.latest_evaluation,null);
   assert.deepEqual(await counts(),before);
 });
 }finally{
   globalThis.fetch=originalFetch;const {unlink}=await import('node:fs/promises');await unlink(fixture);
 }
 return cases;
}
