import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localPurchaseReviews } from '../scripts/local-purchase-reviews.js';

test('review notifications coalesce and rescan when another review finishes during discovery', async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  let opened = 0, closed = 0, queries = 0;
  const hook = localPurchaseReviews(async () => {
    opened++;
    return { async query() { if (++queries === 1) { entered(); await paused; } return { rows: [] }; },
      async close() { closed++; } };
  });
  const first = hook.afterProductReview(); await ready;
  assert.equal(hook.afterProductReview(), first);
  assert.equal(hook.afterProductReview(), first);
  release(); assert.deepEqual(await first, []);
  assert.equal(opened, 2); assert.equal(closed, 2);
});

test('discovery failure closes connection; explicit recovery creates a fresh one', async () => {
  let opened = 0, closed = 0;
  const hook = localPurchaseReviews(async () => {
    const attempt = ++opened;
    return { async query() { if (attempt === 1) throw new Error('offline'); return { rows: [] }; },
      async close() { closed++; } };
  });
  await assert.rejects(hook.afterProductReview(), /offline/);
  assert.equal(closed, 1);
  assert.deepEqual(await hook.recover(), []);
  assert.equal(opened, 2); assert.equal(closed, 2);
});

test('invalid batch limits fail before opening a connection', () => {
  for (const limit of [0, 101, 1.5]) assert.throws(() => localPurchaseReviews(async () => {
    throw new Error('must not connect');
  }, limit), /invalid_purchase_batch/);
});

test('one sweep drains cursors past deferred baskets without immediately retrying them', async () => {
  const ids = ['10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002'];
  const cursors: unknown[] = [];
  let closed = 0;
  const hook = localPurchaseReviews(async () => ({
    async query(sql: string, parameters: unknown[] = []) {
      if (sql.includes('ORDER BY l.id')) {
        cursors.push(parameters[0]);
        const index = parameters[0] === null ? 0 : ids.indexOf(parameters[0] as string) + 1;
        return { rows: index < ids.length ? [{ value: { list_id: ids[index] } }] : [] };
      }
      if (sql.includes('enter_purchase_operation')) throw Object.assign(new Error('conflict'), { code: '40001' });
      return { rows: [] };
    },
    async close() { closed++; },
  }), 1);
  assert.deepEqual(await hook.afterProductReview(), ids.map(listId => ({ listId, disposition: 'deferred', status: 409 })));
  assert.deepEqual(cursors, [null, ...ids]);
  assert.equal(closed, 1);
});
