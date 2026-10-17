import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { savePurchaseConfiguration, mutatePurchaseSources } from '../.scrappy/api-build/lib/server/purchase-persistence.js';
import { deliverPurchaseNoticeLocally } from '../.scrappy/api-build/lib/server/purchase-notices.js';

export async function runNoticeCases(h) {
 const { admin,connect,value,row,list,product,md5,literal,run,args,capture,evaluate,commit }=h;
 let cases=0;
 const test=async(name,work)=>{await work();cases++;console.log('PASS notices: '+name);};
 const up=resolve('supabase/migrations/20261016040000_purchase_notices.sql');
 const down=resolve('supabase/rollback/20261016040000_purchase_notices.sql');
 const need=md5('notice-need'), a=md5('notice-a'), b=md5('notice-b'), aa=md5('notice-aa'), ab=md5('notice-ab');
 const config=(extra={})=>({schema_version:2,currency:'PEN',budget:'9.50',budget_enabled:true,winner_enabled:true,minimum_savings:'0.50',
   needs:[{id:need,name:'Water',required_quantity:'1',unit:'unit',position:0,allow_surplus:false}],
   offers:[a,b].map((id,i)=>({id,product_id:product(i?4:1),max_purchase_units:null,coverage:[{need_id:need,quantity:'1'}],extras:[]})),
   alternatives:[aa,ab].map((id,i)=>({id,name:i?'B':'A',position:i,scope:[need],items:[{offer_id:i?b:a,purchase_units:1}]})),
   pins:[],reference:[],...extra});
 const publish=async(extra={})=>savePurchaseConfiguration(admin,list(1),String((await row(1)).configuration_version),config(extra));
 const price=async(pa,pb,failed=false)=>mutatePurchaseSources(admin,async()=>{
   for(const [id,p] of [[product(1),pa],[product(4),pb]]) {
     await admin.query(`update products set last_price=${literal(p)}::numeric,consecutive_failures=${failed&&id===product(4)?1:0} where id=${literal(id)};
       insert into price_checks(product_id,checked_at,ok,price,currency,method) values(${literal(id)},'2026-10-16 12:00Z',true,${literal(p)}::numeric,'PEN','json_ld')`);
   }
 },[product(1),product(4)]);
 const calculate=async()=>commit(evaluate(await capture()));
 const events=()=>value(`select coalesce(jsonb_agg(to_jsonb(e) order by transition_number),'[]') from purchase_events e where list_id=${literal(list(1))} and version=(select composition_version from lists where id=${literal(list(1))})`);
 const state=()=>value(`select to_jsonb(s) from purchase_alert_state s where list_id=${literal(list(1))} and version=(select composition_version from lists where id=${literal(list(1))})`);
 const receipts=id=>value(`select jsonb_object_agg(channel,status) from purchase_deliveries where event_id=${literal(id)}`);
 const service=async()=>{const db=await connect();await db.query('set role service_role');return db;};
 await test('unused rollback, service permissions, no client RPC or DML',async()=>{
   run('psql',[...args,'-f',up]);run('psql',[...args,'-f',down]);run('psql',[...args,'-f',up]);
   assert.equal(await value("select to_jsonb(has_function_privilege('anon','public.claim_purchase_delivery(uuid,text)','execute'))"),false);
   assert.equal(await value("select to_jsonb(has_function_privilege('authenticated','public.finish_purchase_delivery(uuid,text,text)','execute'))"),false);
   assert.equal(await value("select to_jsonb(has_table_privilege('service_role','public.purchase_deliveries','update'))"),false);
 });
 await test('first calculation establishes winner baseline; budget equality fires once',async()=>{
   await price('10','12');await publish();await calculate();assert.equal((await events()).length,0);
   await price('9.50','12');const p=evaluate(await capture());await commit(p);await commit(p);
   assert.equal((await events()).length,1);assert.equal((await events())[0].reasons,'budget');
   assert.equal((await state()).budget_reached,true);
 });
 await test('hysteresis exact boundary, suspension on incomplete comparison, recovery',async()=>{
   await price('10','12');await publish({budget:'10.00'});await calculate();
   await price('10.30','12');await calculate();assert.equal((await state()).budget_reached,true);
   await price('11','12',true);await calculate();assert.equal((await state()).budget_reached,true);
   await price('11','12');await calculate();assert.equal((await state()).budget_reached,false);
   await price('9.50','12');await calculate();assert.equal((await events()).length,2);
 });
 await test('below threshold updates baseline; exact threshold combines reasons with one receipt per channel',async()=>{
   await price('10','12');await publish();await calculate();
   await price('10','9.70');await calculate();assert.equal((await events()).length,0);
   await price('9.20','9.70');await calculate();const [event]=await events();
   assert.equal(event.reasons,'both');assert.equal(event.payload.savings,'0.50');
   assert.deepEqual(await receipts(event.id),{ntfy:'pending',email:'pending'});
 });
 await test('old winner repriced with current values; unavailable old winner never invents saving',async()=>{
   await price('10','12');await publish({budget_enabled:false});await calculate();
   await price('20','11');await calculate();assert.equal((await events())[0].payload.savings,'9.00');
   await price('9','11',true);await calculate();assert.equal((await events()).length,1);
 });
 await test('new configuration baseline, pinned total and invalid pin suspend budget',async()=>{
   await price('9','12');await publish({pins:[ab]});await calculate();assert.equal((await events()).length,0);
   await price('8','9',true);await calculate();assert.equal((await state()).budget_reached,false);
   await price('8','9');await calculate();assert.equal((await events())[0].reasons,'budget');
   await publish({budget_enabled:false});await calculate();assert.equal((await events()).length,0);
 });
 await test('concurrent evaluation commits create one event and two channel slots',async()=>{
   await price('10','12');await publish();await calculate();await price('10','9');
   const p=evaluate(await capture()), q=evaluate(await capture());const d1=await service(),d2=await service();
   const results=await Promise.allSettled([commit(p,d1),commit(q,d2)]);await d1.close();await d2.close();
   assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.disposition==='inserted').length,1);
   for(const r of results) if(r.status==='rejected') assert.ok(['40001','PT409'].includes(r.reason.code));
   assert.equal((await events()).length,1);assert.deepEqual(await receipts((await events())[0].id),{ntfy:'pending',email:'pending'});
 });
 await test('partial delivery and ambiguous throw try both channels once; replay inert',async()=>{
   const id=(await events())[0].id,db=await service();let calls=0;
   const channels={ntfy:async message=>{calls++;assert.match(message.message,/Presupuesto alcanzado/);assert.match(message.message,/ganadora/);assert.equal(message.offers.length,2);throw Error('timeout');},email:async()=>{calls++;return 'sent';}};
   assert.deepEqual(await deliverPurchaseNoticeLocally(db,id,channels),{ntfy:'ambiguous',email:'sent'});
   await deliverPurchaseNoticeLocally(db,id,channels);assert.equal(calls,2);
   assert.deepEqual(await receipts(id),{ntfy:'ambiguous',email:'sent'});await db.close();
 });
 await test('both channels fail; concurrent local senders do not duplicate',async()=>{
   await price('10','12');await publish();await calculate();await price('10','9');await calculate();
   const id=(await events())[0].id,d1=await service(),d2=await service();let calls=0,ready,release;
   const entered=new Promise(resolve=>{ready=resolve;}),resume=new Promise(resolve=>{release=resolve;});
   const send=async()=>{calls++;return 'failed';};
   const first=deliverPurchaseNoticeLocally(d1,id,{ntfy:async()=>{ready();await resume;return send();},email:send});
   await entered;
   try {await deliverPurchaseNoticeLocally(d2,id,{ntfy:send,email:send});} finally {release();}
   await first;
   assert.equal(calls,2);assert.deepEqual(await receipts(id),{ntfy:'failed',email:'failed'});
   assert.equal(await value(`select to_jsonb(status) from purchase_events where id=${literal(id)}`),'failed');await d1.close();await d2.close();
 });
 await test('lost receipt response retains claim and never replays; other channel proceeds',async()=>{
   await price('10','12');await publish();await calculate();await price('10','9');await calculate();
   const id=(await events())[0].id,db=await service();let calls=0,broken=false;
   const wrapper={async query(sql,params){if(!broken&&sql.includes('finish_purchase_delivery')){broken=true;throw Error('lost receipt');}return db.query(sql,params);}};
   const send=async()=>{calls++;return 'sent';};
   assert.deepEqual(await deliverPurchaseNoticeLocally(wrapper,id,{ntfy:send,email:send}),{ntfy:'unrecorded',email:'sent'});
   await deliverPurchaseNoticeLocally(db,id,{ntfy:send,email:send});assert.equal(calls,2);
   assert.deepEqual(await receipts(id),{ntfy:'claimed',email:'sent'});await db.close();
 });
 await test('lost claim response sends nothing on uncertain channel; retry cannot reclaim',async()=>{
   await price('10','12');await publish();await calculate();await price('10','9');await calculate();
   const id=(await events())[0].id,db=await service();let calls=0,claimed=false,lost=false;
   const wrapper={async query(sql,params){const result=await db.query(sql,params);if(sql.includes('claim_purchase_delivery'))claimed=true;
     if(sql==='COMMIT'&&claimed&&!lost){lost=true;throw Error('lost commit');}return result;}};
   const send=async()=>{calls++;return 'sent';};
   assert.deepEqual(await deliverPurchaseNoticeLocally(wrapper,id,{ntfy:send,email:send}),{ntfy:'unrecorded',email:'sent'});
   await deliverPurchaseNoticeLocally(db,id,{ntfy:send,email:send});assert.equal(calls,1);await db.close();
 });
 await test('used down is protected; individual and legacy notice histories untouched',async()=>{
   assert.throws(()=>run('psql',[...args,'-f',down]),/Command failed/);
   assert.equal(await value('select count(*)::int from notifications'),0);
   assert.equal(await value('select count(*)::int from basket_events'),0);
   assert.equal(await value("select count(*)::int from products where alert_state<>'armed'"),0);
 });
 return cases;
}
