import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { localReadings } from '../.scrappy/api-build/scripts/local-readings.js';
import { localPurchaseReviews } from '../.scrappy/api-build/scripts/local-purchase-reviews.js';
import { savePurchaseConfiguration } from '../.scrappy/api-build/lib/server/purchase-persistence.js';

export async function runLocalReviewCases({ admin, connect, value, row, list, product, literal, psql, args }) {
  let cases = 0;
  const test = async (name, work) => { await work(); cases++; console.log('PASS local review: ' + name); };
  const service = async () => { const db = await connect(); await db.query('set role service_role'); return db; };
  const hook = localPurchaseReviews(service, 1);
  const counts = () => value(`select jsonb_build_object('evaluations',(select count(*) from purchase_evaluations),
    'checks',(select count(*) from price_checks),'notices',(select count(*) from notifications),
    'deliveries',(select count(*) from purchase_deliveries),'legacy',(select count(*) from basket_snapshots))`);
  const archive = () => value(`select archive from purchase_evaluations where id=(select current_evaluation_id from purchase_runtime where list_id=${literal(list(1))})`);
  const root = await mkdtemp(resolve('.scrappy/local-purchase-review-'));
  let executor;
  try {
    await symlink(resolve('.venv'), resolve(root, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(resolve(root, 'scraper/src/scrappy'), { recursive: true });
    await writeFile(resolve(root, 'scraper/src/scrappy/__init__.py'), `__path__.append(${JSON.stringify(resolve('scraper/src/scrappy'))})`);
    await writeFile(resolve(root, 'scraper/src/scrappy/run.py'), await readFile('tests/fixtures/local-purchase-review.py'));
    async function review({ ok, at, crash_after_save = false }, callback = hook.afterProductReview) {
      await writeFile(resolve(root, 'fixture.json'), JSON.stringify({ ok, at, crash_after_save, psql, args, runner: resolve('scraper/src/scrappy/run.py') }));
      let completed, failed;
      const done = new Promise((yes, no) => { completed = yes; failed = no; });
      executor = localReadings(root, { afterProductReview: async () => {
        try { const result = await callback(); completed(result); } catch (error) { failed(error); }
      } });
      try {
        await executor.dispatchProduct(product(2));
        await executor.dispatchProduct(product(2)); // one process, one saved review
        return await Promise.race([done, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('local review completion timeout')), 15000); timer.unref();
        })]);
      } finally { executor.close(); }
    }
    await test('explicit recovery drains all pages; pinned failed offer recovers through real Python runner', async () => {
      await admin.query("update fixture_clock set at_time='2026-10-16 12:35Z'");
      // Enable only temporary fixture configuration; no real activation path.
      const editable = { schema_version: 2, currency: 'PEN', budget: '100', budget_enabled: false, winner_enabled: false, minimum_savings: '0',
        needs: [{ id: list(1), name: 'Fixture unit', required_quantity: '1', unit: 'unit', position: 0, allow_surplus: false }],
        offers: [{ id: product(2), product_id: product(2), max_purchase_units: null, coverage: [{ need_id: list(1), quantity: '1' }], extras: [] }],
        alternatives: [{ id: list(2), name: 'Pinned fixture', position: 0, scope: [list(1)], items: [{ offer_id: product(2), purchase_units: 1 }] }],
        pins: [list(2)], reference: [] };
      await savePurchaseConfiguration(admin, list(1), String((await row(1)).configuration_version), editable);
      const initial = await hook.recover(); assert.equal(initial.filter(o => o.disposition === 'committed').length, 4);
      const before = await counts();
      for (const ok of [false, true]) {
        const outcomes = await review({ ok, at: ok ? '2026-10-16T12:32:00+00:00' : '2026-10-16T12:31:00+00:00' });
        assert.deepEqual(outcomes, [{ listId: list(1), disposition: 'committed' }]);
        const snapshot = await archive();
        assert.equal(snapshot.result.effective.coverageComplete, ok, JSON.stringify(snapshot.result));
        assert.deepEqual((await archive()).inputs.pins, editable.pins);
      }
      const after = await counts();
      assert.equal(after.checks, before.checks + 2); assert.equal(after.evaluations, before.evaluations + 2);
      for (const key of ['notices', 'deliveries', 'legacy']) assert.equal(after[key], before[key]);
    });
    await test('nonzero child exit still recalculates a durably saved review', async () => {
      const before = await counts();
      assert.equal((await review({ ok: false, at: '2026-10-16T12:33:00+00:00', crash_after_save: true }))[0].disposition, 'committed');
      assert.equal((await archive()).result.effective.coverageComplete, false);
      assert.equal((await counts()).checks, before.checks + 1);
    });
    await test('post-review outage survives executor restart; explicit recovery does not scrape or duplicate', async () => {
      const before = await counts();
      await assert.rejects(review({ ok: true, at: '2026-10-16T12:34:00+00:00' }, async () => { throw new Error('fixture offline'); }), /fixture offline/);
      assert.equal((await row(1)).dirty, true);
      const restarted = localPurchaseReviews(service, 1);
      assert.equal((await restarted.recover())[0].disposition, 'committed');
      assert.equal((await archive()).result.effective.coverageComplete, true);
      assert.deepEqual(await restarted.recover(), []);
      const after = await counts(); assert.equal(after.checks, before.checks + 1); assert.equal(after.evaluations, before.evaluations + 1);
      for (const key of ['notices', 'deliveries', 'legacy']) assert.equal(after[key], before[key]);
    });
  } finally {
    executor?.close();
    if (!root.startsWith(resolve('.scrappy') + sep)) throw new Error('Unsafe fixture directory');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return cases;
}
