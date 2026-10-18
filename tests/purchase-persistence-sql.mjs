import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { capturePurchaseInputs, commitPurchaseEvaluation, mutatePurchaseSources, purchaseHash, validatePurchaseCommit } from '../.scrappy/api-build/lib/server/purchase-persistence.js';
import { capturePurchaseSnapshot, canonicalJson } from '../.scrappy/api-build/lib/server/purchase-snapshots.js';
import { runPublicationCases } from './purchase-publication-cases.mjs';
import { runRecalculationCases } from './purchase-recalculation-cases.mjs';
import { runNoticeCases } from './purchase-notice-cases.mjs';
import { runPurchaseApiCases } from './purchase-api-cases.mjs';
import { runLocalReviewCases } from './local-purchase-review-cases.mjs';
import { runWorkerCases } from './purchase-worker-cases.mjs';
import { runAdapterCases } from './purchase-adapter-cases.mjs';
import { runActivationCases } from './purchase-activation-cases.mjs';

// No .env, live clients, browser, network services or fixed test port.
const bin = process.env.POSTGRES_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
const exe = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const root = resolve('.scrappy'); await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, 'purchase-persistence-pg-')), data = join(dir, 'data');
const run = (name, args) => execFileSync(exe(name), args, { encoding: 'utf8', windowsHide: true, stdio: name === 'pg_ctl' ? 'ignore' : 'pipe', timeout: 60000 });
const listener = createServer();
await new Promise((ok, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', ok); });
const port = listener.address().port; await new Promise(ok => listener.close(ok));
const args = ['-X', '-q', '-At', '-P', 'null=null', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres'];
const literal = value => value === null ? 'NULL' : Array.isArray(value) ? `ARRAY[${value.map(literal).join(',')}]::uuid[]` : typeof value === 'boolean' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const connections = [];
const publications = process.env.PURCHASE_PUBLICATION_LOCAL === '1';
const recalculations = process.env.PURCHASE_RECALCULATION_LOCAL === '1';
const notices = process.env.PURCHASE_NOTICES_LOCAL === '1';
const purchaseApi = process.env.PURCHASE_API_LOCAL === '1';
const localReviews = process.env.PURCHASE_LOCAL_REVIEWS === '1';
const worker = process.env.PURCHASE_WORKER_LOCAL === '1';
const activation = process.env.PURCHASE_ACTIVATION_LOCAL === '1';
const adapters = process.env.PURCHASE_ADAPTERS_LOCAL === '1';
const writers = process.env.PURCHASE_WRITERS_LOCAL === '1' || publications || recalculations || notices || purchaseApi || localReviews || worker || adapters || activation;
async function connect(name = randomUUID()) {
  const child = spawn(exe('psql'), args, { windowsHide: true, stdio: 'pipe' });
  let buffer = '', errors = '', pending, ended = false, closing = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk.replaceAll('\r', '');
    if (pending && buffer.includes(pending.marker + '\n')) {
      const output = buffer.slice(0, buffer.indexOf(pending.marker)).trim(); buffer = '';
      const task = pending; pending = undefined;
      try {
        task.ok({ rows: output ? output.split(/\r?\n/).filter(Boolean).map(line => ({ value: JSON.parse(line) })) : [] });
      } catch (error) { task.fail(error); }
    }
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.on('error', error => pending?.fail(error));
  child.on('error', error => pending?.fail(error));
  const exited = new Promise(ok => child.on('exit', () => { ended = true; pending?.fail(Object.assign(new Error(errors || 'psql disconnected'), { code: errors.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1] })); pending = undefined; ok(); }));
  const db = {
    async query(sql, parameters = []) {
      if (pending || ended || closing) throw new Error('Connection is busy or closed');
      const marker = 'END_' + randomUUID();
      return new Promise((ok, fail) => {
        const timer=setTimeout(()=>{child.kill(); fail(new Error('psql protocol timeout'));},20000);
        pending = { ok: result=>{clearTimeout(timer);ok(result);}, fail:error=>{clearTimeout(timer);fail(error);}, marker };
        child.stdin.write(sql.replace(/\$(\d+)/g, (_, i) => literal(parameters[Number(i) - 1])) + ';\n\\echo ' + marker + '\n');
      });
    },
    async close() {
      if (!ended && !closing) { closing = true; child.stdin.end('\\q\n'); }
      await exited;
    },
  };
  connections.push(db);
  await db.query(`set application_name=${literal(name)}; set statement_timeout='15s'`);
  return db;
}
const md5 = text => { const h = createHash('md5').update(text).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; };
const list = n => md5('list' + n), product = n => md5('product' + n);
let started = false, cases = 0;
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']); started = true;
  const sql = query => run('psql', [...args, '-c', query]);
  sql('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const name of (await readdir('supabase/migrations')).filter(n => n.endsWith('.sql') && n < '20261016000000').sort()) run('psql', [...args, '-f', resolve('supabase/migrations', name)]);
  sql(`insert into lists(id,name,position,budget,currency) select md5('list'||n)::uuid,'Basket '||n,n,100,case when n=3 then 'USD' else 'PEN' end from generate_series(1,5) n;
    insert into products(id,url,domain,name,currency,reference_price,last_price,last_success_at,last_checked_at,status)
    select md5('product'||n)::uuid,'https://example.test/'||n,'example.test','Product '||n,case when n=2 then 'USD' else 'PEN' end,20,10,'2026-10-16 12:00Z','2026-10-16 12:00Z','active' from generate_series(1,4) n;
    insert into price_checks(product_id,checked_at,ok,price,currency,method) select id,last_success_at,true,last_price,currency,'json_ld' from products;
    insert into basket_items(id,list_id,product_id,quantity,position) values
      (md5('item1')::uuid,md5('list1')::uuid,md5('product1')::uuid,1,0),
      (md5('item2')::uuid,md5('list1')::uuid,md5('product2')::uuid,1,1),
      (md5('item3')::uuid,md5('list2')::uuid,md5('product1')::uuid,1,0),
      (md5('item4')::uuid,md5('list3')::uuid,md5('product1')::uuid,1,0);
    insert into exchange_rates(rate_date,rate,source,fetched_at) values('2026-10-16',3.75,'BCRPData:PD04638PD','2026-10-16 12:00Z');
    create table fixture_clock(at_time timestamptz); insert into fixture_clock values('2026-10-16 12:30Z');
    create function public.purchase_test_now() returns timestamptz language sql stable as 'select at_time from public.fixture_clock';`);
  run('psql', [...args, '-f', resolve('supabase/migrations/20261016000000_purchase_shadow.sql')]);
  // Only the temporary database substitutes its deterministic clock; production SQL has no clock override.
  const migration = await readFile('supabase/migrations/20261016010000_purchase_persistence.sql', 'utf8');
  const fixtureMigration = join(dir, 'up.sql');
  await writeFile(fixtureMigration, migration.replaceAll('clock_timestamp()', 'public.purchase_test_now()').replaceAll('statement_timestamp()', 'public.purchase_test_now()'));
  run('psql', [...args, '-f', fixtureMigration]);
  sql("update lists set purchase_mode='alternatives' where position<5;"); // isolated fixtures, never real activation
  if (writers) {
    // Operational products have complete individual targets; the older protocol fixture did not need them.
    sql("update products set target_type='price',target_price=9");
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016020000_purchase_writers.sql')]);
    sql(`begin isolation level serializable;
      select public.enter_purchase_operation();
      insert into basket_items(list_id,product_id,quantity,position) values(${literal(list(5))},${literal(product(4))},1,0);
      commit`);
  }
  const admin = await connect('purchase-admin');
  const value = async (query, db = admin) => (await db.query(query)).rows[0]?.value;
  const row = async n => value(`select to_jsonb(r) from purchase_runtime r where list_id=${literal(list(n))}`);
  const runtimeRows = async () => {
    const rows = [];
    for (const n of [1,2,3,4,5]) rows.push(await row(n));
    return rows;
  };
  const capture = async (n = 1, db = admin) => capturePurchaseInputs(db, list(n), (await row(n)).configuration_version.toString());
  const evaluate = captured => ({ capture: captured.capture, snapshot: capturePurchaseSnapshot(captured.capture.list_id, captured.inputs, { ...captured.capture.limits, now: () => 0 }) });
  const commit = async (payload, db = admin) => commitPurchaseEvaluation(db, payload.capture.list_id, payload.capture.configuration_version, payload.capture.capture_signature, payload);
  const rejectCommit = async (payload, code = 'PT409', message) => {
    const db = await connect(); await assert.rejects(commit(payload, db), error => error.code === code && (!message || error.message.includes(message))); await db.close();
  };
  const invalidate = (products, fx = false, configs = [], work = async () => {}) => mutatePurchaseSources(admin, work, products.map(product), fx, configs.map(list));
  const current = n => value(`select public.read_current_purchase_evaluation(${literal(list(n))})`);
  const count = () => value('select count(*)::int from purchase_evaluations');
  let writerGroup = 0;
  const test = async (name, work) => {
    if (publications || recalculations || notices || purchaseApi || localReviews || worker || adapters || activation) return;
    if (writers !== name.startsWith('writers:')) return;
    if (writers && ++writerGroup < Number(process.env.PURCHASE_WRITERS_FROM ?? 1)) return;
    await work(); cases++; console.log('PASS ' + name);
  };

  await test('SQL/TS canonical capture, trusted adapter and immutable idempotent retry', async () => {
    const p = evaluate(await capture());
    validatePurchaseCommit(list(1), p.capture.configuration_version, p.capture.capture_signature, p);
    const inserted = await commit(p), before = await row(1), existing = await commit(p);
    assert.equal(inserted.disposition, 'inserted'); assert.equal(existing.disposition, 'existing'); assert.deepEqual(existing.snapshot, p.snapshot);
    assert.deepEqual(await row(1), before); assert.equal(await count(), 1);
    assert.equal((await current(1)).evaluation_id, inserted.evaluation_id);
    assert.ok(before.previous_effective.length); assert.ok(before.previous_recommendation.length);
    const other = structuredClone(p); let tick=0;
    other.snapshot = capturePurchaseSnapshot(list(1), p.snapshot.inputs, { ...p.capture.limits, now: () => (tick++)*2100 });
    assert.equal(other.snapshot.result.effective.limitReason,'deadline');
    assert.equal(other.snapshot.input_signature, p.snapshot.input_signature); await rejectCommit(other, 'PT409', 'evaluation_conflict');
    const db = await connect(); await assert.rejects(db.query(`update purchase_evaluations set result=result where id=${literal(inserted.evaluation_id)}`), e => e.code==='PT409');
  });
  await test('same-state captures commit by CAS, never by timestamp; stale retry stays obsolete', async () => {
    const earlier = evaluate(await capture());
    await admin.query("update fixture_clock set at_time=at_time+interval '1 second'");
    const later = evaluate(await capture()); await commit(later); await rejectCommit(earlier);
    await invalidate([2]); await rejectCommit(later);
    assert.equal((await row(1)).dirty, true); assert.equal((await row(1)).current_evaluation_id, null);
  });
  await test('excluded failure/suspect/stock/recovery, same-price checks and ABA invalidate captures', async () => {
    for (const update of ["consecutive_failures=1", "status='error'", "last_availability='OutOfStock'", "status='active',consecutive_failures=0,last_availability=null", 'last_price=11', 'last_price=10']) {
      const old = evaluate(await capture()); const before = await row(1);
      await invalidate([2], false, [], () => admin.query(`update products set ${update} where id=${literal(product(2))}`));
      await rejectCommit(old); assert.equal((await row(1)).input_revision, before.input_revision + 1);
    }
    const old = evaluate(await capture()), before = await row(1);
    await invalidate([2], false, [], () => admin.query(`insert into price_checks(product_id,checked_at,ok,price,currency) values(${literal(product(2))},'2026-10-16 12:20Z',true,10,'USD')`));
    await rejectCommit(old); assert.equal((await row(1)).input_revision, before.input_revision + 1);
    const fresh = evaluate(await capture()); assert.notEqual(fresh.capture.capture_signature, old.capture.capture_signature);
  });
  await test('shared, standalone, legacy and current-version dependencies; one increment per transaction', async () => {
    const before = await runtimeRows();
    await invalidate([1,1,4]); const after = await runtimeRows();
    for (let i=0;i<5;i++) assert.equal(after[i].input_revision-before[i].input_revision,i<3?1:0);
    assert.equal(await value('select count(*)::int from purchase_events'),0);
    assert.equal(await value("select count(*)::int from notifications"),0);
  });
  await test('missing FX insert, unchanged upsert, replace/delete affect foreign baskets only', async () => {
    await invalidate([],true,[],()=>admin.query('delete from exchange_rates'));
    for (const command of ["insert into exchange_rates(rate_date,rate,source,fetched_at) values('2026-10-16',3.75,'BCRPData:PD04638PD','2026-10-16 12:00Z')", 'update exchange_rates set rate=rate', 'update exchange_rates set rate=3.8', 'delete from exchange_rates']) {
      const old = evaluate(await capture()), native = await row(2), foreign = await row(3);
      await invalidate([], true, [], () => admin.query(command)); await rejectCommit(old);
      assert.deepEqual(await row(2), native); assert.equal((await row(3)).input_revision, foreign.input_revision+1);
    }
  });
  await test('midnight stales current without writes; FX five-to-six-day boundary excludes', async () => {
    await invalidate([], true, [], () => admin.query("insert into exchange_rates(rate_date,rate,source,fetched_at) values('2026-10-11',3.75,'BCRPData:PD04638PD','2026-10-11 12:00Z')"));
    await admin.query("update fixture_clock set at_time='2026-10-17 04:59:59Z'");
    const old = evaluate(await capture()), native = evaluate(await capture(2));
    assert.equal(old.snapshot.result.effective.coverageComplete,true); await commit(old); await commit(native);
    const before = await row(1); await admin.query("update fixture_clock set at_time='2026-10-17 05:00:00Z'");
    assert.equal((await current(1)).stale_reason,'date'); assert.equal((await current(2)).evaluation_id,null);
    assert.deepEqual(await row(1),before); await rejectCommit(old); await rejectCommit(native);
    const fresh = evaluate(await capture()); assert.equal(fresh.snapshot.result.effective.coverageComplete,false);
    await commit(fresh); assert.ok((await current(1)).evaluation_id);
    assert.deepEqual((await row(1)).previous_effective,before.previous_effective);
  });
  await test('configuration/mode change, old history and late workers are isolated', async () => {
    const old = evaluate(await capture(2)), before = await row(2);
    await invalidate([], false, [2], async () => {
      await admin.query(`insert into purchase_configurations(list_id,version,configuration,currency,budget) select list_id,version+1,configuration,currency,99 from purchase_configurations where list_id=${literal(list(2))} and version=${before.configuration_version};
        update lists set composition_version=composition_version+1 where id=${literal(list(2))}`);
    });
    await rejectCommit(old); const after = await row(2);
    assert.equal(after.input_revision,before.input_revision+1); assert.equal(after.state_revision,before.state_revision+1); assert.equal(after.current_evaluation_id,null);
    // Old-version offers must not invalidate a now-empty configuration.
    await invalidate([1]); assert.deepEqual(await row(2),after);
    const empty = evaluate(await capture(2)); assert.equal(empty.snapshot.result.effective.total,null); await commit(empty);
    const mode = evaluate(await capture(2));
    await invalidate([],false,[2],()=>admin.query(`update lists set purchase_mode='legacy' where id=${literal(list(2))}`)); await rejectCommit(mode);
  });
  await test('atomic rollback after evaluation insert leaves dirty work and immutable history', async () => {
    await invalidate([1]); const p = evaluate(await capture()), before = await row(1), total = await count();
    await admin.query("create function fixture_reject_runtime() returns trigger language plpgsql as $$ begin raise exception 'injected_after_insert'; end $$; create trigger fixture_fail before update on purchase_runtime for each row execute function fixture_reject_runtime()");
    const db = await connect(); await assert.rejects(commit(p, db), /injected_after_insert/); await db.close();
    await admin.query('drop trigger fixture_fail on purchase_runtime; drop function fixture_reject_runtime()');
    assert.deepEqual(await row(1),before); assert.equal(await count(),total); await commit(p);
    const original = await row(1), db2 = await connect();
    await assert.rejects(mutatePurchaseSources(db2, async()=> { await db2.query(`update products set last_price=123 where id=${literal(product(1))}`); throw new Error('optimistic_rejection'); },[product(1)]), /optimistic_rejection/);
    assert.deepEqual(await row(1),original);
  });
  await test('mixed replayable projection rejected by SQL, deleted basket never resurrected', async () => {
    const p = evaluate(await capture()); const altered = structuredClone(p.snapshot.inputs); altered.offers[0].price='0.01';
    await rejectCommit({capture:p.capture,snapshot:capturePurchaseSnapshot(list(1),altered,{...p.capture.limits,now:()=>0})},'PT400','projection_mismatch');
    const gone = evaluate(await capture(4));
    await mutatePurchaseSources(admin,()=>admin.query(`delete from lists where id=${literal(list(4))}`),[]);
    await rejectCommit(gone,'PT404'); assert.equal(await row(4),undefined);
  });
  await test('RLS, service grants and SERIALIZABLE fail closed', async () => {
    for (const role of ['anon','authenticated']) {
      for (const command of ['select * from purchase_runtime','select * from purchase_operation_gate',`select capture_purchase_inputs(${literal(list(1))},1)`]) {
        const db=await connect(); await assert.rejects(db.query(`set role ${role}; ${command}`),e=>e.code==='42501');
      }
    }
    const db=await connect(); await assert.rejects(db.query('begin; select public.enter_purchase_operation()'),e=>e.code==='PT409');
    const service=await connect(), version=String((await row(1)).configuration_version);
    await service.query('set role service_role'); await capturePurchaseInputs(service,list(1),version);
  });
  // Barrier is observed in pg_stat_activity, never a timing sleep.
  async function blocked(name) {
    for (let i=0;i<2000;i++) if(await value(`select to_jsonb(exists(select 1 from pg_stat_activity where application_name=${literal(name)} and wait_event_type='Lock'))`)) return;
    throw new Error('Barrier was not reached: '+name);
  }
  await test('capture before review and review before capture: waiting old snapshot aborts 40001', async () => {
    const version=String((await row(1)).configuration_version);
    for (const captureFirst of [true,false]) {
      const a=await connect(), name='waiting-'+randomUUID(), b=await connect(name);
      await a.query('begin isolation level serializable'); await a.query('select public.enter_purchase_operation()');
      if(captureFirst) await a.query('select public.capture_purchase_inputs($1::uuid,$2::bigint)',[list(1),version]);
      else await a.query(`update products set consecutive_failures=consecutive_failures+1 where id=${literal(product(1))}; select public.invalidate_purchase_inputs(ARRAY[${literal(product(1))}]::uuid[],false,'{}')`);
      const waiting=captureFirst?mutatePurchaseSources(b,()=>b.query(`update products set last_price=9 where id=${literal(product(1))}`),[product(1)]):capturePurchaseInputs(b,list(1),version);
      // Attach rejection immediately, before releasing the controlled lock.
      const outcome=waiting.then(()=>null,e=>e); await blocked(name); await a.query('commit');
      assert.equal((await outcome)?.code,'40001'); await a.close(); await b.close();
    }
  });
  await test('two identical workers behind a gate: one insert, one serialization conflict; identical retry existing', async () => {
    const p=evaluate(await capture()), total=await count(), a=await connect(), name='commit-'+randomUUID(), b=await connect(name);
    await a.query('begin isolation level serializable'); await a.query('select public.enter_purchase_operation()');
    const outcome=commit(p,b).then(()=>null,e=>e); await blocked(name);
    const valid=validatePurchaseCommit(list(1),p.capture.configuration_version,p.capture.capture_signature,p);
    await a.query('select public.commit_purchase_evaluation($1::uuid,$2::bigint,$3::text,$4::jsonb)',[list(1),p.capture.configuration_version,valid.capture.capture_signature,canonicalJson(p)]); await a.query('commit');
    assert.equal((await outcome)?.code,'40001'); assert.equal(await count(),total+1);
    assert.equal((await commit(p)).disposition,'existing');
  });
  await test('membership publication before product/FX writes cannot miss a newly dependent basket',async()=>{
    // Basket 2 is currently legacy with an empty configuration; prepare another immutable generation.
    const before=await row(2), version=String(before.configuration_version+1), a=await connect(), name='membership-'+randomUUID(), b=await connect(name);
    await a.query('begin isolation level serializable; select public.enter_purchase_operation()');
    await a.query(`insert into purchase_configurations(list_id,version,configuration,currency,budget) values(${literal(list(2))},${version},'{}','PEN',100);
      insert into purchase_offers(list_id,version,id,product_id) values(${literal(list(2))},${version},${literal(md5('new-offer'))},${literal(product(2))});
      update lists set composition_version=${version},purchase_mode='alternatives' where id=${literal(list(2))};
      select public.invalidate_purchase_inputs('{}',false,ARRAY[${literal(list(2))}]::uuid[])`);
    const outcome=mutatePurchaseSources(b,()=>b.query('update exchange_rates set rate=4'),[product(2)],true).then(()=>null,e=>e);
    await blocked(name); await a.query('commit'); assert.equal((await outcome)?.code,'40001');
    const published=await row(2); assert.equal(published.input_revision,before.input_revision+1);
    // A fresh explicit source transaction now discovers the new dependency exactly once.
    await invalidate([2],true,[],()=>admin.query('update exchange_rates set rate=4'));
    assert.equal((await row(2)).input_revision,published.input_revision+1);
  });
  await test('missing gate fails closed; rollback refuses active history and restores the additive schema when empty',async()=>{
    await admin.query('begin isolation level serializable; delete from purchase_operation_gate');
    await assert.rejects(admin.query('select public.capture_purchase_inputs($1::uuid,1)',[list(1)]),e=>e.code==='PT409');
    // Session exit rolled back the missing gate, including its deletion.
    const check=await connect();
    assert.equal(await value('select count(*)::int from purchase_operation_gate',check),1);
    const down=resolve('supabase/rollback/20261016010000_purchase_persistence.sql');
    assert.throws(()=>run('psql',[...args,'-f',down]),/Command failed/);
    await check.query('delete from lists'); // fixtures and evaluations cascade, no real data
    run('psql',[...args,'-f',down]);
    assert.equal(await value("select to_jsonb(to_regclass('public.purchase_runtime') is null)",check),true);
    assert.equal(await value("select count(*)::int from information_schema.columns where table_name='purchase_evaluations' and column_name in ('capture','archive','committed_state_revision')",check),0);
  });
  if (writers && !publications && !recalculations && !notices && !purchaseApi && !activation) {
    const rpc = async (command, db) => {
      const connection = db ?? await connect();
      await connection.query('begin isolation level serializable; set local role service_role');
      try { const result = await connection.query(command); await connection.query('commit'); return result; }
      catch (error) { try { await connection.query('rollback'); } catch {} throw error; }
    };
    const edit = changes => `select to_jsonb(t) from public.mutate_product(${literal(product(1))},'edit',${literal(JSON.stringify(changes))}::jsonb) t`;
    const version = async n => String(await value(`select composition_version from lists where id=${literal(list(n))}`));
    const check = (at, ok = true) => JSON.stringify([{checked_at:at,ok,price:ok?'10':null,currency:'PEN',method:'json_ld',error_code:ok?null:'blocked'}]);
    const review = (at, prior, ok = true) => `select public.save_review(${literal(product(1))},${literal(prior)}::timestamptz,${literal(at)}::timestamptz,${ok},${literal(check(at,ok))}::jsonb)`;
    await test('writers: inventory, isolation metadata and closed direct/private bypasses', async () => {
      assert.equal(await value('select count(*)::int from purchase_writer_internal.originals'),15);
      assert.equal(await value(`select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
        and (p.proname in(select name from purchase_writer_internal.originals where name not like 'snapshot_%')
        or p.proname in ('mutate_product','save_product_alert_state','record_notification'))
        and p.prosecdef and 'default_transaction_isolation=serializable'=any(p.proconfig)
        and p.prosrc like '%begin perform public.enter_purchase_operation();%'`),13);
      for (const command of [
        `update products set status='paused' where id=${literal(product(1))}`,
        `delete from lists where id=${literal(list(5))}`,
        `insert into price_checks(product_id,checked_at,ok) values(${literal(product(1))},now(),false)`,
        `delete from exchange_rates`, `delete from product_readings`, `delete from basket_events`,
        `delete from basket_items`, `delete from basket_snapshots`, `delete from notifications`,
        `select purchase_writer_internal.save_review(null,null,null,null,null)`,
      ]) {
        const db=await connect(); await db.query('set role service_role');
        await assert.rejects(db.query(command),e=>e.code==='42501');
      }
      const db=await connect(); await db.query('set role service_role');
      await assert.rejects(db.query(edit({status:'paused'})),e=>e.code==='PT409');
    });
    await test('writers: pause/resume/reference invalidate each current dependent basket exactly once', async () => {
      for (const changes of [{status:'paused'},{status:'active'},{reference_price:'21.00'}]) {
        const before=await runtimeRows(), versions=[];
        for (const n of [1,2,3]) versions.push(await version(n));
        await rpc(edit(changes)); const after=await runtimeRows();
        for (const n of [0,1,2]) { assert.equal(after[n].input_revision,before[n].input_revision+1); assert.equal(await version(n+1),versions[n]); }
        for (const n of [3,4]) assert.deepEqual(after[n],before[n]);
      }
    });
    await test('writers: real save_review failure/recovery/same price checks, stale rejection and atomic rollback', async () => {
      let prior='2026-10-16 12:00Z';
      for (const [at,ok] of [['2026-10-16 13:00Z',false],['2026-10-16 14:00Z',true],['2026-10-16 15:00Z',true]]) {
        const before=await row(1), old=evaluate(await capture());
        await rpc(review(at,prior,ok)); assert.equal((await row(1)).input_revision,before.input_revision+1);
        await rejectCommit(old); prior=at;
      }
      const before=await row(1), fence=await value('select fence from purchase_operation_gate'), count=await value('select count(*)::int from price_checks');
      await assert.rejects(rpc(review('2026-10-16 16:00Z','2026-10-16 12:00Z')));
      assert.deepEqual(await row(1),before); assert.equal(await value('select fence from purchase_operation_gate'),fence);
      assert.equal(await value('select count(*)::int from price_checks'),count);
      const db=await connect(); await db.query('begin isolation level serializable');
      await db.query(review('2026-10-16 16:00Z',prior)); await db.query('rollback');
      assert.deepEqual(await row(1),before); assert.equal(await value('select count(*)::int from price_checks'),count);
    });
    const reading=md5('writer-repair');
    const confirmation=JSON.stringify({same_product:true,currency:'PEN',name:'Product 1',reference_price:'20',target_type:'price',target_value:'9',check_interval_hours:3});
    await test('writers: repair queue/claim/complete/confirm and idempotent retry',async()=>{
      const before=await row(1);
      await rpc(`select public.create_product_repair(${literal(reading)},${literal(product(1))},'https://example.test/repaired',null)`);
      await rpc(`select public.claim_product_reading(${literal(reading)})`);
      await rpc(`select public.complete_product_reading(${literal(reading)},'${JSON.stringify({price:'10',currency:'PEN',name:'Product 1',confidence:1,candidates:[],method:'json_ld'})}'::jsonb,'{}')`);
      assert.deepEqual(await row(1),before);
      await rpc(`select public.confirm_product_reading(${literal(reading)},${literal(confirmation)}::jsonb)`);
      assert.equal((await row(1)).input_revision,before.input_revision+1);
      const after=await row(1); await rpc(`select public.confirm_product_reading(${literal(reading)},${literal(confirmation)}::jsonb)`);
      assert.deepEqual(await row(1),after);
    });
    await test('writers: FX upsert invalidation and legacy guards/claims stay isolated',async()=>{
      const before=await runtimeRows();
      await rpc(`select public.cache_exchange_rate('${JSON.stringify({from_currency:'USD',to_currency:'PEN',source:'BCRPData:PD04638PD',rate_date:'2026-10-16',rate:'4',fetched_at:'2026-10-16 18:00Z'})}'::jsonb)`);
      const after=await runtimeRows();
      for(const n of [0,2]) assert.equal(after[n].input_revision,before[n].input_revision+1);
      for(const n of [1,3,4]) assert.deepEqual(after[n],before[n]);
      for(const command of [
        `select public.configure_list_basket(${literal(list(1))},99,'PEN')`,
        `select public.set_basket_item(${literal(list(1))},${literal(product(1))},2,${await version(1)})`,
      ]) await assert.rejects(rpc(command),e=>e.code==='PT409');
      const claims=await rpc('select to_jsonb(t) from public.claim_basket_events(null) t');
      assert.equal(claims.rows.length,1);
      assert.ok(claims.rows.every(r=>r.value.list_id===list(5)));
      assert.deepEqual(await row(1),after[0]);
    });
    await test('writers: individual alert CAS and audit receipt keep purchase inputs unchanged',async()=>{
      const before=await row(1), p=await value(`select to_jsonb(p) from products p where id=${literal(product(1))}`);
      const expected=JSON.stringify({alert_state:p.alert_state,last_alert_price:p.last_alert_price,last_alert_at:p.last_alert_at});
      const command=`select to_jsonb(t) from public.save_product_alert_state(${literal(product(1))},${literal(p.last_checked_at)},${literal(expected)},'{"alert_state":"triggered","last_alert_price":"10"}') t`;
      assert.equal((await rpc(command)).rows.length,1); assert.equal((await rpc(command)).rows.length,0);
      await rpc(`select public.record_notification('${JSON.stringify({product_id:product(1),type:'goal_reached',channel:'ntfy',status:'sent',payload:{fixture:true},sent_at:'2026-10-16 18:00Z'})}'::jsonb)`);
      assert.deepEqual(await row(1),before);
    });
    await test('writers: every entry blocks at the gate before existing source/reading/list/event locks',async()=>{
      const entries=[
        edit({status:'paused'}),review('2026-10-16 19:00Z','2026-10-16 18:00Z'),
        `select public.cache_exchange_rate('{}')`, `select public.create_product_reading(null,null,null)`,
        `select public.create_product_repair(null,null,null,null)`, `select public.claim_product_reading(null)`,
        `select public.complete_product_reading(null,'{}','{}')`, `select public.confirm_product_reading(null,'{}')`,
        `select public.mutate_list('rename',${literal(list(1))},'renamed')`,
        `select public.configure_list_basket(null,10,'PEN')`, `select public.set_basket_item(null,null,1,1)`,
        `select to_jsonb(t) from public.claim_basket_events(null) t`, `select public.finish_basket_event(null,true)`,
        `select public.record_basket_snapshot(null)`, `select to_jsonb(t) from public.save_product_alert_state(null,null,'{}','{}') t`,
        `select public.record_notification('{}')`, `select to_jsonb(t) from public.mutate_product(null,'delete') t`,
      ];
      for(const command of entries) {
        const a=await connect(), name='writer-'+randomUUID(), b=await connect(name);
        await a.query('begin isolation level serializable; select public.enter_purchase_operation()');
        const outcome=rpc(command,b).then(()=>null,e=>e); await blocked(name);
        // No tuple/relation lock on an operational table before the gate is obtained.
        assert.equal(await value(`select count(*)::int from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name=${literal(name)} and l.relation in ('products'::regclass,'product_readings'::regclass,'lists'::regclass,'basket_events'::regclass)`),0);
        await a.query('commit'); assert.equal((await outcome)?.code,'40001'); await a.close(); await b.close();
      }
    });
    await test('writers: review holds gate then capture aborts; explicit fresh capture sees whole review',async()=>{
      const a=await connect(), name='capture-after-writer-'+randomUUID(), b=await connect(name), ver=await version(1);
      const prior=await value(`select to_jsonb(last_checked_at) from products where id=${literal(product(1))}`);
      // Repair confirmation records database time; preserve its precision and advance monotonically.
      const next=await value(`select to_jsonb(last_checked_at + interval '1 second') from products where id=${literal(product(1))}`);
      await a.query('begin isolation level serializable'); await a.query(review(next,prior));
      const outcome=capturePurchaseInputs(b,list(1),ver).then(()=>null,e=>e); await blocked(name);
      await a.query('commit'); assert.equal((await outcome)?.code,'40001');
      const fresh=await capture(); assert.equal(fresh.inputs.offers.find(o=>o.productId===product(1)).pendingFailure,false);
    });
    await test('writers: FK delete conflict and missing gate roll back without invalidation',async()=>{
      const before=await row(1);
      await assert.rejects(rpc(`select to_jsonb(t) from public.mutate_product(${literal(product(1))},'delete') t`),e=>['23001','23503'].includes(e.code));
      assert.deepEqual(await row(1),before);
      const db=await connect(); await db.query('begin isolation level serializable; delete from purchase_operation_gate');
      await assert.rejects(db.query(edit({status:'paused'})),e=>e.code==='PT409');
      assert.equal(await value('select count(*)::int from purchase_operation_gate'),1);
    });
    await test('writers: protected down and exact restored legacy definitions/grants',async()=>{
      const down=resolve('supabase/rollback/20261016020000_purchase_writers.sql');
      assert.throws(()=>run('psql',[...args,'-f',down]),/Command failed/);
      const definitions=await value(`select jsonb_object_agg(name,definition) from purchase_writer_internal.originals`);
      const grants=await value(`select jsonb_agg(to_jsonb(g) order by table_name,privilege_type) from purchase_writer_internal.grants g`);
      await admin.query("update lists set purchase_mode='legacy'"); run('psql',[...args,'-f',down]);
      for(const [name,definition] of Object.entries(definitions)) assert.equal(await value(`select to_jsonb(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${literal(name)}`),definition);
      assert.deepEqual(await value(`select jsonb_agg(jsonb_build_object('table_name',table_name,'privilege_type',privilege_type) order by table_name,privilege_type) from information_schema.table_privileges where table_schema='public' and grantee='service_role'`),grants);
    });
  }
  if (localReviews) {
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016030000_purchase_publication.sql')]);
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016040000_purchase_notices.sql')]);
    cases = await runLocalReviewCases({ admin, connect, value, row, list, product, literal, psql: exe('psql'), args });
  }
  if (publications) cases = await runPublicationCases({ admin, connect, value, row, list, product, md5, literal, blocked, run, args, capture, evaluate, commit });
  if (recalculations) {
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016030000_purchase_publication.sql')]);
    cases = await runRecalculationCases({ admin, connect, value, row, list, product, literal });
  }
  if (notices) {
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016030000_purchase_publication.sql')]);
    cases = await runNoticeCases({ admin, connect, value, row, list, product, md5, literal, run, args, capture, evaluate, commit });
  }
  if (purchaseApi) {
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016030000_purchase_publication.sql')]);
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016040000_purchase_notices.sql')]);
    cases = await runPurchaseApiCases({ admin, connect, value, row, list, product, md5, literal, run, args, capture, evaluate, commit });
  }
  if (worker) {
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016030000_purchase_publication.sql')]);
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016040000_purchase_notices.sql')]);
    cases = await runWorkerCases({ admin, connect, value, row, list, product, literal, capture, evaluate, commit });
  }
  if (activation) {
    for (const name of ['20261016030000_purchase_publication.sql','20261016040000_purchase_notices.sql','20261016050000_purchase_api.sql']) run('psql', [...args, '-f', resolve('supabase/migrations',name)]);
    cases = await runActivationCases({ admin, connect, value, row, list, product, md5, literal, run, args, capture, evaluate, commit });
  }
  if (adapters) {
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016030000_purchase_publication.sql')]);
    run('psql', [...args, '-f', resolve('supabase/migrations/20261016040000_purchase_notices.sql')]);
    cases = await runAdapterCases({ admin, value, row, list, product, literal, port, psql: exe('psql'), args });
  }
  console.log(`Local PostgreSQL: ${cases} acceptance groups passed; temporary cluster only${adapters ? ', adapters/callback' : worker ? ', worker' : localReviews ? ', local review integration' : purchaseApi ? ', API' : notices ? ', notices' : recalculations ? ', recalculation' : publications ? ', publication' : writers ? ', writers integrated' : ', protocol only'}.`);
} finally {
  await Promise.allSettled(connections.map(db=>db.close()));
  if(started) run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
  if(!dir.startsWith(root+(process.platform==='win32'?'\\':'/')) || !dir.split(/[\\/]/).at(-1).startsWith('purchase-persistence-pg-')) throw new Error('Unsafe temporary directory');
  await rm(dir,{recursive:true,force:true});
}
