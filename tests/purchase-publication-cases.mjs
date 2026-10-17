import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { savePurchaseConfiguration, mutatePurchaseSources } from '../.scrappy/api-build/lib/server/purchase-persistence.js';

export async function runPublicationCases(h) {
  const { admin,connect,value,row,list,product,md5,literal,blocked,run,args,capture,evaluate,commit }=h;
  const up=resolve('supabase/migrations/20261016030000_purchase_publication.sql');
  const down=resolve('supabase/rollback/20261016030000_purchase_publication.sql');
  let cases=0;
  const test=async(name,work)=>{await work();cases++;console.log('PASS publication: '+name);};
  const version=async()=>String((await row(1)).configuration_version);
  const need=md5('published-need'), offer=md5('published-offer'), alt=md5('published-alt');
  const config=()=>({schema_version:2,currency:'PEN',budget:'90.00',budget_enabled:true,winner_enabled:true,minimum_savings:'0.50',
    needs:[{id:need,name:'Water',required_quantity:'1',unit:'L',position:0,allow_surplus:false}],
    offers:[{id:offer,product_id:product(2),max_purchase_units:2,coverage:[{need_id:need,quantity:'500'}],extras:[]}],
    alternatives:[{id:alt,name:'Two bottles',position:0,scope:[need],items:[{offer_id:offer,purchase_units:2}]}],pins:[alt],reference:[alt]});
  const save=async(c=config(),expected,db)=>{
    const connection=db??await connect(); await connection.query('set role service_role');
    try {return await savePurchaseConfiguration(connection,list(1),expected??await version(),c);} finally {if(!db) await connection.close();}
  };
  const state=()=>value(`select jsonb_build_object('lists',(select jsonb_agg(to_jsonb(t) order by id) from lists t),
    'runtime',(select jsonb_agg(to_jsonb(t) order by list_id) from purchase_runtime t),
    'configs',(select jsonb_agg(to_jsonb(t) order by list_id,version) from purchase_configurations t),
    'graph',(select jsonb_object_agg(name,rows) from (
      ${['purchase_needs','purchase_offers','purchase_coverages','purchase_extras','purchase_alternatives','purchase_alternative_needs','purchase_alternative_items','purchase_pins','purchase_reference_items','purchase_alert_state','purchase_events','purchase_evaluations','products','price_checks','basket_items','basket_snapshots','basket_events','notifications','purchase_publication_internal.publications'].map(name=>`select ${literal(name)} name,coalesce(jsonb_agg(j order by j::text),'[]') rows from (select to_jsonb(t) j from ${name} t) q`).join(' union all ')}
    ) g))`);
  const reject=async(c,code='PT400',expected)=>{
    const before=await state(); await assert.rejects(save(c,expected),e=>e.code===code,JSON.stringify(c)); assert.deepEqual(await state(),before);
  };
  const counts=()=>value(`select jsonb_build_object('checks',(select count(*) from price_checks),'snapshots',(select count(*) from basket_snapshots),
    'events',(select count(*) from basket_events)+(select count(*) from purchase_events),'notices',(select count(*) from notifications))`);
  await test('unused migration reverses exactly without changing existing data or grants',async()=>{
    const prior=await value(`select jsonb_agg(jsonb_build_object('table',table_name,'privilege',privilege_type) order by table_name,privilege_type)
      from information_schema.table_privileges where table_schema='public' and grantee='service_role'`);
    run('psql',[...args,'-f',up]); const before=await state();
    run('psql',[...args,'-f',down]);
    assert.equal(await value(`select to_jsonb(to_regprocedure('public.save_purchase_configuration(uuid,bigint,jsonb)') is null)`),true);
    run('psql',[...args,'-f',up]); assert.deepEqual(await state(),before);
    assert.deepEqual(await value(`select jsonb_agg(jsonb_build_object('table',table_name,'privilege',privilege_type) order by table_name,privilege_type)
      from information_schema.table_privileges where table_schema='public' and grantee='service_role'`),prior);
  });
  await test('complete service-only publication: canonical graph, one version, revisions, latch and stale worker',async()=>{
    const old=evaluate(await capture()), previous=await row(1), before=await counts();
    const oldGraph=await value(`select configuration from purchase_configurations where list_id=${literal(list(1))} and version=${previous.configuration_version}`);
    const result=await save(); const current=await row(1);
    assert.equal(result.version,String(previous.configuration_version+1)); assert.equal(result.needs[0].unit,'ml'); assert.equal(result.needs[0].required_quantity,'1000.000000');
    assert.equal(current.configuration_version,previous.configuration_version+1); assert.equal(current.input_revision,previous.input_revision+1); assert.equal(current.state_revision,previous.state_revision+1);
    assert.equal(current.current_evaluation_id,null); assert.equal(current.dirty,true); assert.deepEqual(current.previous_effective,[]); assert.deepEqual(current.previous_recommendation,[]);
    assert.deepEqual(await counts(),before);
    assert.deepEqual(await value(`select configuration from purchase_configurations where list_id=${literal(list(1))} and version=${previous.configuration_version}`),oldGraph);
    assert.deepEqual(await value(`select jsonb_build_object('reached',budget_reached,'transition',transition_number,'winner',previous_purchase_signature) from purchase_alert_state where list_id=${literal(list(1))} and version=${current.configuration_version}`),{reached:false,transition:0,winner:null});
    await assert.rejects(commit(old,await connect()),e=>e.code==='PT409');
    const fresh=await capture(); assert.equal(fresh.inputs.offers[0].productId,product(2)); assert.equal(evaluate(fresh).snapshot.result.effective.coverageComplete,true);
    await reject(config(),'PT409',String(previous.configuration_version)); // lost-response replay
  });
  await test('settings-only and identical saves are full generations; logical IDs and provenance persist',async()=>{
    const before=await row(1), first=await save({...config(),budget:'80.00',currency:'USD'}), next=await save({...config(),budget:'80.00',currency:'USD'});
    assert.equal(first.version,String(before.configuration_version+1)); assert.equal(next.version,String(before.configuration_version+2));
    assert.equal(first.needs[0].id,next.needs[0].id); assert.equal(first.needs[0].created_at,next.needs[0].created_at);
  });
  await test('invalid fields/types/decimals/limits/dangling/duplicates roll back the entire graph',async()=>{
    const mutations=[c=>({...c,unknown:true}),c=>({...c,budget:90}),c=>({...c,budget:'0'}),c=>({...c,minimum_savings:'0.001'}),
      c=>({...c,needs:null}),c=>({...c,needs:Array(33).fill(c.needs[0])}),c=>({...c,offers:[{...c.offers[0],product_id:md5('missing')}]}),
      c=>({...c,needs:[c.needs[0],c.needs[0]]}),c=>({...c,pins:[alt,alt]}),c=>({...c,reference:[md5('missing')]}),
      c=>({...c,needs:[{...c.needs[0],allow_surplus:null}]}),c=>({...c,needs:[{...c.needs[0],unit:'unit',required_quantity:'1.5'}]}),
      c=>({...c,needs:[{...c.needs[0],required_quantity:'1e3'}]}),c=>({...c,needs:[{...c.needs[0],required_quantity:'0.0000001'}]}),
      c=>({...c,offers:[{...c.offers[0],coverage:[{need_id:md5('missing'),quantity:'1'}]}]}),
      c=>({...c,offers:[{...c.offers[0],coverage:[...c.offers[0].coverage,...c.offers[0].coverage]}]}),
      c=>({...c,offers:[{...c.offers[0],max_purchase_units:1}]}),
      c=>({...c,alternatives:[{...c.alternatives[0],items:[{offer_id:offer,purchase_units:1.5}]}]}),
      c=>({...c,alternatives:[{...c.alternatives[0],scope:[]}]}),c=>({...c,alternatives:[{...c.alternatives[0],items:[]}]}),
      c=>({...c,offers:[{...c.offers[0],coverage:[{need_id:need,quantity:'750'}]}]}),
      c=>({...c,offers:[{...c.offers[0],extras:[{id:md5('extra'),name:'Extra',quantity:'1',unit:'unit',accepted:false}]}]}),
      c=>({...c,alternatives:[...c.alternatives,{...c.alternatives[0],id:md5('other')}],pins:[alt,md5('other')]}),
      c=>({...c,alternatives:[...c.alternatives,{...c.alternatives[0],id:md5('other')}],reference:[alt,md5('other')]}),
      c=>({...c,needs:[...c.needs,{...c.needs[0],id:md5('other-need')}],offers:[{...c.offers[0],coverage:[...c.offers[0].coverage,{need_id:md5('other-need'),quantity:'1'}]}]}),
    ];
    for(const mutate of mutations) await reject(mutate(config()));
  });
  await test('empty/incomplete drafts, surplus and accepted extras publish without prices/events',async()=>{
    const before=await counts();
    await save({...config(),needs:[],offers:[],alternatives:[],pins:[],reference:[],budget:null});
    assert.deepEqual((await capture()).inputs.needs,[]);
    await save({...config(),alternatives:[],pins:[],reference:[]});
    const c=config(); c.needs[0].allow_surplus=true; c.offers[0].coverage[0].quantity='750';
    c.offers[0].extras=[{id:md5('extra'),name:'Extra',quantity:'0.5',unit:'kg',accepted:true}];
    const saved=await save(c); assert.equal(saved.offers[0].extras[0].quantity,'500.000000'); assert.equal(saved.offers[0].extras[0].unit,'g');
    assert.deepEqual(await counts(),before);
  });
  await test('permission/isolation/missing-gate/missing-list and legacy fail closed',async()=>{
    const v=await version();
    for(const role of ['anon','authenticated']) {
      const db=await connect(); await db.query(`set role ${role}`);
      await assert.rejects(savePurchaseConfiguration(db,list(1),v,config()),e=>e.code==='42501');
    }
    const db=await connect(); await assert.rejects(db.query(`begin;select public.save_purchase_configuration($1::uuid,$2::bigint,$3::jsonb)`,[list(1),v,JSON.stringify(config())]),e=>e.code==='PT409');
    const missing=await connect(); await missing.query('begin isolation level serializable;delete from purchase_operation_gate');
    await assert.rejects(missing.query(`select public.save_purchase_configuration($1::uuid,$2::bigint,$3::jsonb)`,[list(1),v,JSON.stringify(config())]),e=>e.code==='PT409');
    assert.equal(await value('select count(*)::int from purchase_operation_gate'),1);
    const service=await connect(); await service.query('set role service_role');
    await assert.rejects(savePurchaseConfiguration(service,md5('missing-list'),'1',config()),e=>e.code==='PT404');
    const legacy=await connect(); await legacy.query('set role service_role');
    await assert.rejects(savePurchaseConfiguration(legacy,list(5),'1',config()),e=>e.code==='PT409');
    const direct=await connect(); await direct.query('set role service_role');
    await assert.rejects(direct.query(`update purchase_configurations set configuration='{}'`),e=>e.code==='42501');
  });
  const held=async(db,c,v)=>db.query('select public.save_purchase_configuration($1::uuid,$2::bigint,$3::jsonb)',[list(1),v,JSON.stringify(c)]);
  await test('two publishers: first commits once, blocked stale snapshot fails, stale replay remains conflict',async()=>{
    const v=await version(), a=await connect(), name=randomUUID(), b=await connect(name);
    await a.query('begin isolation level serializable'); await held(a,config(),v);
    const outcome=save(config(),v,b).then(()=>null,e=>e); await blocked(name);
    assert.equal(await version(),v); await a.query('commit'); assert.equal((await outcome)?.code,'40001');
    assert.equal(await version(),String(BigInt(v)+1n)); await reject(config(),'PT409',v);
  });
  await test('publication versus evaluation commit in both orders preserves history and clears current result',async()=>{
    for(const publicationFirst of [true,false]) {
      const payload=evaluate(await capture()), v=await version(), a=await connect(), name=randomUUID(), b=await connect(name);
      await a.query('begin isolation level serializable');
      if(publicationFirst) await held(a,config(),v);
      else await a.query('select public.enter_purchase_operation()');
      const outcome=(publicationFirst?commit(payload,b):save(config(),v,b)).then(()=>null,e=>e); await blocked(name);
      if(!publicationFirst) await a.query('select public.commit_purchase_evaluation($1::uuid,$2::bigint,$3::text,$4::jsonb)',[list(1),v,payload.capture.capture_signature,JSON.stringify(payload)]);
      await a.query('commit'); assert.equal((await outcome)?.code,'40001');
      if(!publicationFirst) await save(config(),v);
      const r=await row(1); assert.equal(r.dirty,true); assert.equal(r.current_evaluation_id,null);
      await assert.rejects(commit(payload,await connect()),e=>e.code==='PT409');
    }
  });
  await test('publication versus new product/FX dependencies in both orders aborts old snapshots and discovers fresh inputs',async()=>{
    // Start without the newly published USD dependency.
    for(const fx of [false,true]) for(const publicationFirst of [true,false]) {
      await save({...config(),offers:[],alternatives:[],pins:[],reference:[]});
      const v=await version(), a=await connect(), name=randomUUID(), b=await connect(name);
      const source=fx?'update exchange_rates set rate=rate+0.01':`update products set consecutive_failures=consecutive_failures+1 where id=${literal(product(2))}`;
      await a.query('begin isolation level serializable');
      if(publicationFirst) await held(a,config(),v);
      else {await a.query('select public.enter_purchase_operation()');await a.query(source);await a.query('select public.invalidate_purchase_inputs($1::uuid[],$2::boolean)',[[product(2)],fx]);}
      const outcome=(publicationFirst?mutatePurchaseSources(b,()=>b.query(source),[product(2)],fx):save(config(),v,b)).then(()=>null,e=>e);
      await blocked(name);await a.query('commit');assert.equal((await outcome)?.code,'40001');
      if(!publicationFirst) await save(config(),v);
      const prior=await row(1);
      await mutatePurchaseSources(admin,()=>admin.query(source),[product(2)],fx);
      assert.equal((await row(1)).input_revision,prior.input_revision+1);
      assert.equal((await capture()).inputs.offers[0].productId,product(2));
    }
    // Removed dependency no longer invalidates the current version; historical offers remain.
    await save({...config(),offers:[],alternatives:[],pins:[],reference:[]}); const prior=await row(1);
    await mutatePurchaseSources(admin,()=>admin.query(`update products set consecutive_failures=0 where id=${literal(product(2))}`),[product(2)]);
    assert.deepEqual(await row(1),prior);
  });
  await test('protected down refuses publication even after mode reset; preserves graph and RPC',async()=>{
    await admin.query("update lists set purchase_mode='legacy'"); const before=await state();
    assert.throws(()=>run('psql',[...args,'-f',down]),/Command failed/); assert.deepEqual(await state(),before);
    assert.equal(await value(`select to_jsonb(to_regprocedure('public.save_purchase_configuration(uuid,bigint,jsonb)') is not null)`),true);
  });
  return cases;
}
