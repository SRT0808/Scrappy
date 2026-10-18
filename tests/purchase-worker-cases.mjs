import assert from 'node:assert/strict';
import { purchaseWorker, PurchaseWorkerError } from '../.scrappy/api-build/lib/server/purchase-worker.js';
import { savePurchaseConfiguration, mutatePurchaseSources } from '../.scrappy/api-build/lib/server/purchase-persistence.js';

export async function runWorkerCases({ admin, connect, value, row, list, product, literal, capture, evaluate, commit }) {
  let cases = 0, group = 0, sends = [];
  const firstGroup = Number(process.env.PURCHASE_WORKER_FROM ?? 1);
  assert.ok(Number.isInteger(firstGroup) && firstGroup >= 1 && firstGroup <= 8);
  const test = async (name, work) => {
    if (++group < firstGroup) return;
    await work(); cases++; console.log('PASS worker: ' + name);
  };
  const service = async () => { const db = await connect(); await db.query('set role service_role'); return db; };
  const channels = Object.fromEntries(['ntfy', 'email'].map(channel => [channel, async (_message, context) => {
    sends.push({ channel, ...context }); return 'sent';
  }]));
  const worker = (extra = {}) => purchaseWorker({ connect: service, channels, now: () => 0, ...extra });
  const run = () => worker().recover();
  const counts = () => value(`select jsonb_build_object('evaluations',(select count(*) from purchase_evaluations),
    'checks',(select count(*) from price_checks),'legacy',(select count(*) from basket_snapshots),
    'notices',(select count(*) from notifications),'events',(select count(*) from purchase_events))`);
  const receipts = id => value(`select jsonb_object_agg(channel,status) from purchase_deliveries where event_id=${literal(id)}`);
  const baseline = await counts();
  const config = (enabled = true) => ({ schema_version: 2, currency: 'PEN', budget: '100', budget_enabled: enabled,
    winner_enabled: false, minimum_savings: '0',
    needs: [{ id: list(1), name: 'Water', required_quantity: '1', unit: 'unit', position: 0, allow_surplus: false }],
    offers: [{ id: product(1), product_id: product(1), max_purchase_units: null, coverage: [{ need_id: list(1), quantity: '1' }], extras: [] }],
    alternatives: [{ id: list(2), name: 'Single', position: 0, scope: [list(1)], items: [{ offer_id: product(1), purchase_units: 1 }] }],
    pins: [], reference: [] });
  const publish = async (enabled = true) => savePurchaseConfiguration(admin, list(1), String((await row(1)).configuration_version), config(enabled));
  const event = () => value(`select to_jsonb(e) from purchase_events e where list_id=${literal(list(1))} order by version desc limit 1`);
  const frozenEvent = async () => { await publish(); await commit(evaluate(await capture())); return event(); };

  await test('zero product reviews still recalculates config, FX, Lima day and valid incomplete comparisons', async () => {
    const before = await counts();
    assert.equal((await run()).recalculations.length, 4);
    await publish(false); assert.equal((await run()).recalculations.length, 1);
    await mutatePurchaseSources(admin, () => admin.query('update exchange_rates set rate=3.80'), [], true);
    assert.ok((await run()).recalculations.length >= 1);
    await admin.query("update fixture_clock set at_time=at_time+interval '6 days'");
    assert.equal((await run()).recalculations.length, 4);
    const incomplete = await value(`select result from purchase_evaluations where id=(select current_evaluation_id from purchase_runtime where list_id=${literal(list(3))})`);
    assert.equal(incomplete.effective.coverageComplete, false);
    assert.equal((await run()).recalculations.length, 0);
    const after = await counts();
    for (const key of ['checks', 'legacy', 'notices']) assert.equal(after[key], before[key]);
    // Shadow fixtures retain enabled legacy budgets: their FIRST qualifying
    // evaluation legitimately creates notices even without new product checks.
    assert.equal(after.events, before.events + 3);
  });

  await test('early conflicting UUID does not starve later baskets or pending deliveries', async () => {
    const pending = await frozenEvent();
    await mutatePurchaseSources(admin, async () => {}, [product(1)], true);
    const first = await value("select to_jsonb(min(id::text)) from lists where purchase_mode='alternatives' and read_current_purchase_evaluation(id)->>'evaluation_id' is null");
    const report = await worker({ connect: async () => {
      const db = await service();
      return { async query(sql, args) {
        if (sql.includes('capture_purchase_inputs(l.id') && args[0] === first) throw Object.assign(Error('conflict'), { code: '40001' });
        return db.query(sql, args);
      }, close: () => db.close() };
    } }).recover();
    assert.equal(report.recalculations[0].listId, first); assert.equal(report.recalculations[0].status, 409);
    assert.ok(report.recalculations.slice(1).some(o => o.disposition === 'committed'));
    assert.ok(report.deliveries.some(d => d.event.eventId === pending.id));
    assert.deepEqual(await receipts(pending.id), { ntfy: 'sent', email: 'sent' });
    assert.equal((await run()).recalculations.length, 1);
  });

  await test('crash after evaluation recovers old-version pending event without duplicate evaluation', async () => {
    await publish(); let opened = 0;
    await assert.rejects(worker({ connect: async () => {
      if (++opened === 2) throw Error('crash before delivery'); return service();
    } }).recover(), PurchaseWorkerError);
    const old = await event(); assert.deepEqual(await receipts(old.id), { ntfy: 'pending', email: 'pending' });
    await publish(false);
    const report = await run();
    const recovered = report.deliveries.find(d => d.event.eventId === old.id);
    assert.equal(recovered.event.configurationVersion, String(old.version));
    assert.equal(sends.filter(s => s.eventId === old.id).length, 2);
    const after = await counts(); await run(); assert.deepEqual(await counts(), after);
  });

  await test('26 durable events page by archived timestamp/UUID across versions, ignoring aggregate status', async () => {
    for (let i = 0; i < 26; i++) {
      if (i === 13) await admin.query("update fixture_clock set at_time=at_time+interval '1 microsecond'");
      await frozenEvent();
    }
    // Aggregate status alone must never hide an independently pending channel.
    await admin.query("update purchase_events set status='sent' where id in (select event_id from purchase_deliveries where status='pending')");
    const expected = await value(`select jsonb_agg(e.id order by v.evaluated_at,e.id) from purchase_events e
      join purchase_evaluations v on v.id=e.evaluation_id where exists(select 1 from purchase_deliveries d where d.event_id=e.id and d.status='pending')`);
    const before = await counts(), report = await run();
    assert.equal(report.recalculations.length, 0); assert.equal(report.deliveries.length, 26);
    assert.deepEqual(report.deliveries.map(d => d.event.eventId), expected);
    assert.equal((await counts()).evaluations, before.evaluations);
    assert.equal((await run()).deliveries.length, 0);
  });

  await test('concurrent workers commit once and independently claim channels without duplicate send', async () => {
    await publish(); const before = await counts();
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; }), pause = new Promise(resolve => { release = resolve; });
    const first = worker({ channels: { ...channels, ntfy: async (...args) => {
      entered(); await pause; return channels.ntfy(...args);
    } } }).recover();
    await ready;
    try { await run(); } finally { release(); }
    await first; const id = (await event()).id;
    assert.equal((await counts()).evaluations, before.evaluations + 1);
    assert.equal(sends.filter(s => s.eventId === id).length, 2);
    assert.deepEqual(await receipts(id), { ntfy: 'sent', email: 'sent' });
  });

  await test('rejection and ambiguous timeout are terminal across worker restart', async () => {
    const id = (await frozenEvent()).id; let calls = 0;
    await worker({ channels: { ntfy: async () => { calls++; return 'failed'; },
      email: async () => { calls++; throw Error('uncertain'); } } }).recover();
    assert.deepEqual(await receipts(id), { ntfy: 'failed', email: 'ambiguous' });
    await run(); assert.equal(calls, 2); assert.equal(sends.filter(s => s.eventId === id).length, 0);
  });

  await test('lost durable claim/finish acknowledgements fail step, preserve receipts and never replay', async () => {
    for (const phase of ['claim', 'finish']) {
      const id = (await frozenEvent()).id;
      let lost = false, current;
      const broken = worker({ connect: async () => {
        const db = await service();
        return { async query(sql, args) {
          const result = await db.query(sql, args);
          if (sql.includes('claim_purchase_delivery')) current = 'claim';
          if (sql.includes('finish_purchase_delivery')) current = 'finish';
          if (!lost && sql === 'COMMIT' && current === phase) { lost = true; throw Error('lost acknowledgement'); }
          return result;
        }, close: () => db.close() };
      } });
      await assert.rejects(broken.recover(), PurchaseWorkerError);
      assert.deepEqual(await receipts(id), { ntfy: phase === 'claim' ? 'claimed' : 'sent', email: 'sent' });
      const before = sends.length; await run(); assert.equal(sends.length, before);
      assert.equal(sends.filter(s => s.eventId === id).length, phase === 'claim' ? 1 : 2);
    }
  });

  await test('deadline between channels leaves pending channel recoverable on new connection', async () => {
    const id = (await frozenEvent()).id; let time = 0;
    const report = await worker({ now: () => time, channels: { ...channels,
      ntfy: async (...args) => { time = 180000; return channels.ntfy(...args); } } }).recover();
    assert.equal(report.deadlineReached, true); assert.equal(report.remaining.deliveries, true);
    assert.deepEqual(await receipts(id), { ntfy: 'sent', email: 'pending' });
    await run(); assert.equal(sends.filter(s => s.eventId === id).length, 2);
    const totals = await counts();
    for (const key of ['checks', 'legacy', 'notices']) assert.equal(totals[key], baseline[key], `${key} conserved from fixture baseline`);
  });
  return cases;
}
