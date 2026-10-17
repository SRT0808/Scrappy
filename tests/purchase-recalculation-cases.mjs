import assert from 'node:assert/strict';
import { recalculatePendingPurchases } from '../.scrappy/api-build/lib/server/purchase-recalculation.js';
import { mutatePurchaseSources, savePurchaseConfiguration } from '../.scrappy/api-build/lib/server/purchase-persistence.js';

export async function runRecalculationCases({ admin, connect, value, row, list, product, literal }) {
  let cases = 0;
  const test = async (name, work) => { await work(); cases++; console.log('PASS recalculation: ' + name); };
  const service = async () => { const db = await connect(); await db.query('set role service_role'); return db; };
  const run = async (options) => { const db = await service(); try { return await recalculatePendingPurchases(db, options); } finally { await db.close(); } };
  const dirty = () => mutatePurchaseSources(admin, async () => {}, [product(2)]);
  const counts = () => value(`select jsonb_build_object('evaluations',(select count(*) from purchase_evaluations),
    'checks',(select count(*) from price_checks),'events',(select count(*) from purchase_events)+(select count(*) from basket_events),
    'notices',(select count(*) from notifications),'snapshots',(select count(*) from basket_snapshots))`);
  const archive = () => value(`select archive from purchase_evaluations where id=(select current_evaluation_id from purchase_runtime where list_id=${literal(list(1))})`);
  // Intercept the successful end of capture, outside its transaction and locks.
  const afterCapture = (db, action) => {
    let transactions = 0;
    return { async query(sql, args) {
      const result = await db.query(sql, args);
      if (sql === 'COMMIT' && ++transactions === 1) await action();
      return result;
    } };
  };
  await test('bounded batches drain with cursor; legacy excluded; clean pass is inert', async () => {
    const before = await counts();
    let cursor, outcomes = [];
    do {
      const batch = await run({ limit: 1, ...(cursor ? { afterListId: cursor } : {}) });
      outcomes.push(...batch.outcomes); cursor = batch.nextAfterListId;
    } while (cursor);
    assert.equal(outcomes.length, 4); assert.ok(outcomes.every(o => o.disposition === 'committed'));
    assert.ok(outcomes.every(o => o.listId !== list(5)));
    const after = await counts(); assert.equal(after.evaluations, before.evaluations + 4);
    for (const key of ['checks', 'events', 'notices', 'snapshots']) assert.equal(after[key], before[key]);
    assert.deepEqual((await run()).outcomes, []); assert.deepEqual(await counts(), after);
  });
  await test('many source changes coalesce; independent baskets and scraping untouched', async () => {
    const before = await counts(), independent = await row(2);
    await dirty(); await dirty(); await dirty();
    assert.deepEqual((await run()).outcomes, [{ listId: list(1), disposition: 'committed' }]);
    const after = await counts(); assert.equal(after.evaluations, before.evaluations + 1);
    assert.equal(after.checks, before.checks); assert.deepEqual(await row(2), independent);
    assert.equal((await row(1)).dirty, false);
  });
  await test('source conflict persists pending work; fresh pass recovers without stale commit', async () => {
    await dirty(); const before = await counts(), db = await service();
    const result = await recalculatePendingPurchases(afterCapture(db, dirty)); await db.close();
    assert.deepEqual(result.outcomes, [{ listId: list(1), disposition: 'deferred', status: 409 }]);
    assert.equal((await row(1)).dirty, true); assert.equal((await counts()).evaluations, before.evaluations);
    assert.equal((await run()).outcomes[0].disposition, 'committed');
  });
  await test('publication between capture and commit discards old version and recovers latest', async () => {
    await dirty(); const before = await row(1), oldCount = (await counts()).evaluations, db = await service();
    const need = list(1), offer = product(2), alternative = list(2);
    const config = { schema_version: 2, currency: 'PEN', budget: '90', budget_enabled: false, winner_enabled: false, minimum_savings: '0',
      needs: [{ id: need, name: 'One unit', required_quantity: '1', unit: 'unit', position: 0, allow_surplus: false }],
      offers: [{ id: offer, product_id: product(2), max_purchase_units: null, coverage: [{ need_id: need, quantity: '1' }], extras: [] }],
      alternatives: [{ id: alternative, name: 'Pinned unit', position: 0, scope: [need], items: [{ offer_id: offer, purchase_units: 1 }] }],
      pins: [alternative], reference: [alternative] };
    const result = await recalculatePendingPurchases(afterCapture(db, () => savePurchaseConfiguration(admin, list(1), String(before.configuration_version), config)));
    await db.close(); assert.equal(result.outcomes[0].status, 409);
    assert.equal((await counts()).evaluations, oldCount); assert.equal((await row(1)).dirty, true);
    await run(); assert.equal((await archive()).configuration_version, String(before.configuration_version + 1));
  });
  await test('real product review failure and recovery recalculate the pinned selection without scraping', async () => {
    await admin.query("update fixture_clock set at_time='2026-10-16 12:35Z'");
    assert.equal((await archive()).result.effective.coverageComplete, true);
    const before = await counts();
    for (const ok of [false, true]) {
      const prior = await value(`select to_jsonb(last_checked_at) from products where id=${literal(product(2))}`);
      const at = ok ? '2026-10-16 12:32Z' : '2026-10-16 12:31Z';
      const checks = JSON.stringify([{ checked_at: at, ok, price: ok ? '10' : null, currency: 'USD', method: 'json_ld', error_code: ok ? null : 'blocked' }]);
      await admin.query('begin isolation level serializable');
      await admin.query(`select public.save_review(${literal(product(2))},${literal(prior)}::timestamptz,${literal(at)}::timestamptz,${ok},${literal(checks)}::jsonb)`);
      await admin.query('commit');
      assert.equal((await row(1)).dirty, true); assert.equal((await run()).outcomes[0].disposition, 'committed');
      const snapshot = await archive(); assert.equal(snapshot.result.effective.coverageComplete, ok);
      assert.deepEqual(snapshot.inputs.pins, [list(2)]);
    }
    const after = await counts(); assert.equal(after.checks, before.checks + 2);
    assert.equal(after.evaluations, before.evaluations + 2);
    assert.equal(after.events, before.events); assert.equal(after.notices, before.notices);
  });
  await test('two workers capture same revision; only one commits; loser recovers inertly', async () => {
    await dirty(); const before = await counts(), db = await service();
    let ready, release;
    const captured = new Promise(resolve => { ready = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    const first = recalculatePendingPurchases(afterCapture(db, async () => { ready(); await resume; }));
    await captured;
    try { assert.equal((await run()).outcomes[0].disposition, 'committed'); } finally { release(); }
    assert.equal((await first).outcomes[0].status, 409); await db.close();
    assert.equal((await counts()).evaluations, before.evaluations + 1);
    assert.deepEqual((await run()).outcomes, []);
  });
  await test('stale discovery rechecks under gate and skips a completed basket', async () => {
    await dirty(); const before = await counts(), db = await service(); let once = true;
    const stale = { async query(sql, args) {
      const result = await db.query(sql, args);
      if (once && sql.includes('ORDER BY l.id')) { once = false; await run(); }
      return result;
    } };
    assert.equal((await recalculatePendingPurchases(stale)).outcomes[0].disposition, 'skipped'); await db.close();
    assert.equal((await counts()).evaluations, before.evaluations + 1);
  });
  await test('worker disconnect after capture preserves pending work across connections', async () => {
    await dirty(); const before = await counts(), db = await service();
    const interrupted = afterCapture(db, async () => { await db.close(); throw Object.assign(new Error('lost connection'), { code: '08006' }); });
    assert.equal((await recalculatePendingPurchases(interrupted)).outcomes[0].status, 503);
    assert.equal((await row(1)).dirty, true); assert.equal((await counts()).evaluations, before.evaluations);
    assert.equal((await run()).outcomes[0].disposition, 'committed');
  });
  await test('lost commit response rediscovers completed work without duplicate history', async () => {
    await dirty(); const before = await counts(), db = await service(); let commits = 0;
    const ambiguous = { async query(sql, args) {
      const result = await db.query(sql, args);
      if (sql === 'COMMIT' && ++commits === 2) { await db.close(); throw Object.assign(new Error('response lost'), { code: '08006' }); }
      return result;
    } };
    assert.equal((await recalculatePendingPurchases(ambiguous)).outcomes[0].status, 503);
    assert.equal((await row(1)).dirty, false); assert.deepEqual((await run()).outcomes, []);
    assert.equal((await counts()).evaluations, before.evaluations + 1);
  });
  await test('Lima midnight rediscovers clean baskets; no events, receipts or scraping', async () => {
    const before = await counts(); await admin.query("update fixture_clock set at_time=at_time+interval '1 day'");
    const result = await run(); assert.equal(result.outcomes.length, 4);
    assert.ok(result.outcomes.every(o => o.disposition === 'committed'));
    const after = await counts(); assert.equal(after.evaluations, before.evaluations + 4);
    for (const key of ['checks', 'events', 'notices', 'snapshots']) assert.equal(after[key], before[key]);
  });
  return cases;
}
