import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const publication = c => { const copy=structuredClone(c); delete copy.version;
 copy.needs=copy.needs.map(({legacy_item_id,created_at,...n})=>n);return copy; };

export async function runActivationCases(h) {
 const {admin,connect,value,list,product,literal,run,args,capture,evaluate,commit}=h;
 let cases=0,group=0;
 const from=Number(process.env.PURCHASE_ACTIVATION_FROM ?? 1);
 const test=async(name,work)=>{if(++group<from)return;await work();cases++;console.log('PASS activation: '+name);};
 const up=resolve('supabase/migrations/20261017000000_purchase_activation.sql');
 const down=resolve('supabase/rollback/20261017000000_purchase_activation.sql');
 if(from>1) run('psql',[...args,'-f',up]);
 const preview=(n=5)=>value(`select public.preview_purchase_activation(${literal(list(n))})`);
 const read=(n,request)=>value(`select public.read_purchase_activation(${literal(list(n))},${literal(request)})`);
 const activate=async(p,configuration=p.configuration,request=randomUUID())=>{
  const db=await connect();
  try {
   await db.query('begin isolation level serializable; set local role service_role');
   const r=await value(`select public.activate_purchase_configuration(${literal(p.list_id)},${literal(p.version)}::bigint,${literal(request)},${literal(p.token)},${literal(JSON.stringify(configuration))}::jsonb)`,db);
   await db.query('commit');return r;
  } finally {await db.close();}
 };
 const preserved=(db=admin)=>value(`select jsonb_build_object('products',(select jsonb_agg(to_jsonb(p) order by id) from products p),
  'items',(select jsonb_agg(to_jsonb(i) order by id) from basket_items i),
  'checks',(select jsonb_agg(to_jsonb(c) order by id) from price_checks c),
  'snapshots',(select jsonb_agg(to_jsonb(s) order by id) from basket_snapshots s),
  'notifications',(select jsonb_agg(to_jsonb(n) order by id) from notifications n))`,db);
 const sql=async(q)=>{await admin.query('begin isolation level serializable');await admin.query('select public.enter_purchase_operation()');await admin.query(q);await admin.query('commit');};
 // Later groups need one converted fixture; this is setup, not a repeated acceptance group.
 if(from>3) await activate(await preview());
 await test('migration rollback and service-only access; preview is side effect free',async()=>{
  const before=await preserved();run('psql',[...args,'-f',up]);run('psql',[...args,'-f',down]);run('psql',[...args,'-f',up]);
  for(const role of ['anon','authenticated']) for(const fn of ['preview_purchase_activation(uuid)','read_purchase_activation(uuid,uuid)','activate_purchase_configuration(uuid,bigint,uuid,text,jsonb)'])
   assert.equal(await value(`select to_jsonb(has_function_privilege('${role}','public.${fn}','execute'))`),false);
  assert.equal(await value("select to_jsonb(has_table_privilege('service_role','public.purchase_activations','insert'))"),false);
  const p=await preview();assert.equal(p.configuration.needs.length,1);assert.deepEqual(await preserved(),before);
 });
 await test('stale composition, reviewed source and invalid graphs leave legacy untouched',async()=>{
  const p=await preview(),bad=structuredClone(p.configuration);bad.needs[0].required_quantity='0';
  await assert.rejects(activate(p,bad),e=>e.code==='PT400');
  await assert.rejects(activate({...p,version:'1'}),e=>e.code==='PT409');
  await sql(`update products set last_price=11 where id=${literal(product(4))}`);
  await assert.rejects(activate(p),e=>e.code==='PT409');
  assert.equal(await value(`select to_jsonb(purchase_mode) from lists where id=${literal(list(5))}`),'legacy');
  await sql(`update products set last_price=10 where id=${literal(product(4))}`);
 });
 await test('concurrent confirmations advance once; durable receipt reconciles lost response and replay',async()=>{
  const p=await preview(),before=await preserved(),request=randomUUID();
  const results=await Promise.allSettled([activate(p,p.configuration,request),activate(p,p.configuration,randomUUID())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const receipt=results.find(r=>r.status==='fulfilled').value;
  assert.equal(receipt.version,(BigInt(p.version)+1n).toString());
  assert.equal((await read(5,receipt.request_id)).receipt.version,receipt.version);
  assert.deepEqual(await activate(p,p.configuration,receipt.request_id),receipt);
  await assert.rejects(activate(p,{...p.configuration,winner_enabled:true},receipt.request_id),e=>e.code==='PT409');
  assert.deepEqual(await preserved(),before);
  const c=receipt.configuration;assert.equal(c.needs[0].id,p.configuration.needs[0].id);
  assert.equal(Number(c.needs[0].required_quantity),Number(p.configuration.needs[0].required_quantity));
  assert.equal(c.offers[0].product_id,p.configuration.offers[0].product_id);
  assert.ok(c.needs[0].legacy_item_id);assert.ok(c.needs[0].created_at);
  const captured=await capture(5);assert.equal(evaluate(captured).snapshot.result.effective.total,'10.00');
  await commit(evaluate(captured));assert.equal(await value(`select count(*)::int from purchase_events where list_id=${literal(list(5))}`),0);
 });
 await test('empty graph rejected; oversized conversion rolls back mode and version',async()=>{
  // New isolated legacy fixtures, without changing any activated mode back.
  await sql(`insert into lists(id,name,position,budget,currency) values(${literal(list(6))},'Empty',6,100,'PEN'),(${literal(list(7))},'Large',7,100,'PEN')`);
  const empty=await preview(6);await assert.rejects(activate(empty),e=>e.code==='PT400');
  const large=structuredClone(empty.configuration);const need=randomUUID();
  large.needs=Array.from({length:33},(_,n)=>({id:randomUUID(),name:'Need '+n,required_quantity:'1',unit:'unit',position:n,allow_surplus:false}));
  await assert.rejects(activate(empty,large),e=>e.code==='PT400');
  assert.equal((await preview(6)).version,empty.version);
  const configured=structuredClone((await read(5,(await value(`select to_jsonb(request_id) from purchase_activations where list_id=${literal(list(5))}`)))).receipt.configuration);
  const c=publication(configured);c.budget_enabled=true;c.winner_enabled=true;
  const p=await preview(7);await activate(p,c);
  const db=await connect();const cap=await h.capture(7,db);await commit(evaluate(cap),db);
  const events=await value(`select jsonb_agg(reasons) from purchase_events where list_id=${literal(list(7))}`);
  assert.deepEqual(events,['budget']);
  assert.equal(await value(`select count(*)::int from purchase_events where reasons in ('winner','both') and list_id=${literal(list(7))}`),0);
 });
 await test('mixed legacy writers reject activated baskets and keep independent legacy baskets usable',async()=>{
  const db=await connect();await db.query('begin isolation level serializable; set local role service_role');
  await assert.rejects(db.query(`select public.set_basket_item(${literal(list(5))},${literal(product(4))},2,1)`),e=>e.code==='PT409');
  await sql(`insert into basket_items(list_id,product_id,quantity,position) values(${literal(list(6))},${literal(product(4))},2,0)`);
  const p=await preview(6);assert.equal(p.configuration.alternatives[0].items[0].purchase_units,2);
  assert.equal((await read(5,randomUUID())).receipt,null);
 });
 await test('membership edit conflicts with confirmation; rollback refuses durable receipts',async()=>{
  await sql(`insert into lists(id,name,position,budget,currency) values(${literal(list(8))},'Concurrent membership',8,100,'PEN');
   insert into basket_items(list_id,product_id,quantity,position) values(${literal(list(8))},${literal(product(4))},2,0)`);
  const p=await preview(8),request=randomUUID();
  const writer=await connect();
  await writer.query('begin isolation level serializable; select public.enter_purchase_operation()');
  await writer.query(`update basket_items set quantity=3 where list_id=${literal(list(8))}`);
  // Legacy edits legitimately create snapshots; activation must preserve this edited baseline.
  const before=await preserved(writer);
  // Attach the rejection handler before releasing the writer's transaction gate.
  const rejected=assert.rejects(activate(p,p.configuration,request),e=>['PT409','40001'].includes(e.code));
  await writer.query('commit');await writer.close();await rejected;
  assert.equal(await value(`select to_jsonb(purchase_mode) from lists where id=${literal(list(8))}`),'legacy');
  assert.equal((await read(8,request)).receipt,null);
  const fresh=await preview(8);assert.equal(fresh.configuration.alternatives[0].items[0].purchase_units,3);
  const receipt=await activate(fresh);
  assert.equal(Number((await capture(8)).inputs.needs[0].quantity),3);
  assert.throws(()=>run('psql',[...args,'-f',down]),/activation_receipts_exist_restore_compatible_code/);
  assert.deepEqual((await read(8,receipt.request_id)).receipt,receipt);
  assert.deepEqual(await preserved(),before);
 });
 return cases;
}
