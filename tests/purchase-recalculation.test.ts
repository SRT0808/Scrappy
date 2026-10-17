import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recalculatePendingPurchases } from '../lib/server/purchase-recalculation.js';
import type { PurchaseConnection } from '../lib/server/purchase-persistence.js';

const id = '10000000-0000-0000-0000-000000000001';
test('local batch rejects invalid bounds/cursors before SQL', async () => {
  const db: PurchaseConnection = { async query() { throw new Error('must not query'); } };
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { afterListId: 'bad' }]) {
    await assert.rejects(recalculatePendingPurchases(db, options), /invalid_purchase_batch/);
  }
});
test('bounded discovery preserves UUID cursor and surfaces discovery outage', async () => {
  const calls: unknown[][] = [];
  const db: PurchaseConnection = { async query(sql, args = []) {
    calls.push(args);
    assert.match(sql, /purchase_mode='alternatives'/);
    assert.match(sql, /read_current_purchase_evaluation/);
    return { rows: [] };
  } };
  assert.deepEqual(await recalculatePendingPurchases(db, { limit: 1, afterListId: id }), { outcomes: [], nextAfterListId: null });
  assert.deepEqual(calls, [[id, 1]]);
  await assert.rejects(recalculatePendingPurchases({ async query() { throw new Error('offline'); } }), /offline/);
});
test('conflicts and outages defer each basket once, roll back and retain pagination', async () => {
  const ids = [id, id.replace(/1$/, '2')], calls: string[] = [];
  const db: PurchaseConnection = { async query(sql) {
    calls.push(sql);
    if (sql.includes('ORDER BY l.id')) return { rows: ids.map(list_id => ({ value: { list_id } })) };
    if (sql.includes('enter_purchase_operation')) throw Object.assign(new Error('race'), { code: calls.length < 5 ? '40001' : '08006' });
    return { rows: [] };
  } };
  const result = await recalculatePendingPurchases(db, { limit: 2 });
  assert.deepEqual(result, { outcomes: ids.map((listId, i) => ({ listId, disposition: 'deferred', status: i ? 503 : 409 })), nextAfterListId: ids[1] });
  assert.equal(calls.filter(s => s.startsWith('BEGIN')).length, 2);
  assert.equal(calls.filter(s => s === 'ROLLBACK').length, 2);
});
test('stale discovery skips a deleted, switched or already processed basket under gate', async () => {
  const calls: string[] = [];
  const db: PurchaseConnection = { async query(sql) {
    calls.push(sql);
    return { rows: sql.includes('ORDER BY l.id') ? [{ value: { list_id: id } }] : [] };
  } };
  assert.deepEqual((await recalculatePendingPurchases(db)).outcomes, [{ listId: id, disposition: 'skipped' }]);
  assert.match(calls[2], /enter_purchase_operation/);
  assert.match(calls[3], /capture_purchase_inputs/);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(calls.filter(s => s.startsWith('BEGIN')).length, 1);
});
