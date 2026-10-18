import assert from 'node:assert/strict';
import test from 'node:test';
import { purchaseWorker, PurchaseWorkerError, type PendingPurchaseEvent } from '../lib/server/purchase-worker.js';
import { deliverPurchaseNoticeLocally, type PurchaseNotice } from '../lib/server/purchase-notices.js';

const uuid = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const notice: PurchaseNotice = { reasons: 'budget', currency: 'PEN', effective_total: '9', savings: null,
  basket_path: '/?basket=fixture', offer_urls: [] };
const event = (n: number): PendingPurchaseEvent => ({ eventId: uuid(n), listId: uuid(100),
  evaluatedAt: '2026-10-16 12:00:00.123456+00', configurationVersion: '1' });
const channels = { ntfy: async () => 'sent' as const, email: async () => 'sent' as const };

test('25-item sweeps advance past failing first UUID; pending channels use independent ordered cursor', async () => {
  const ids = Array.from({ length: 26 }, (_, i) => uuid(i + 1));
  const events = ids.map((_, i) => event(i + 1));
  const baskets: unknown[] = [], notices: unknown[][] = [];
  let closed = 0, opens = 0, sends = 0;
  const worker = purchaseWorker({ now: () => 0, channels: {
    ntfy: async (_message, context) => { sends++; assert.equal(context.timeoutMs, 15000);
      assert.equal(context.configurationVersion, '1'); assert.match(context.evaluatedAt, /123456/); return 'sent'; },
    email: async () => { sends++; return 'sent'; },
  }, connect: async budget => {
    assert.equal(budget.connectTimeoutMs, 5000); assert.equal(budget.queryTimeoutMs, 2000);
    assert.equal(budget.remainingMs(), 180000);
    opens++;
    return { async query(sql: string, args: unknown[] = []) {
      if (sql.includes('ORDER BY l.id')) {
        baskets.push(args[0]); assert.equal(args[1], 25);
        return { rows: ids.filter(id => !args[0] || id > String(args[0])).slice(0, 25).map(list_id => ({ value: { list_id } })) };
      }
      if (sql.includes('enter_purchase_operation')) throw Object.assign(Error('conflict'), { code: '40001' });
      if (sql.includes('ORDER BY v.evaluated_at')) {
        assert.match(sql, /d.status='pending'/); assert.doesNotMatch(sql, /e.status=/);
        assert.match(sql, /JOIN public.purchase_evaluations/); assert.match(sql, /LIMIT 25/);
        notices.push(args);
        return { rows: events.filter(e => !args[1] || e.eventId > String(args[1])).slice(0, 25).map(value => ({ value })) };
      }
      return { rows: sql.includes('claim_purchase_delivery') ? [{ value: notice }] : [] };
    }, async close() { closed++; } };
  } });
  const report = await worker.recover();
  assert.equal(report.recalculations.length, 26); assert.equal(report.deliveries.length, 26);
  assert.deepEqual(baskets, [null, ids[24]]);
  assert.deepEqual(notices, [[null, null], [events[24].evaluatedAt, events[24].eventId]]);
  assert.equal(sends, 52); assert.equal(opens, 2); assert.equal(closed, 2);
  assert.equal(report.remaining.recalculations, true); assert.equal(report.deadlineReached, false);
});

test('deadline between baskets stops discovery; recovery starts at beginning on fresh sessions', async () => {
  let time = 0, opened = 0, closed = 0, captures = 0;
  const cursors: unknown[] = [];
  const worker = purchaseWorker({ now: () => time, channels, connect: async () => {
    opened++;
    return { async query(sql: string, args: unknown[] = []) {
      if (sql.includes('ORDER BY l.id')) { cursors.push(args[0]); return { rows: [1, 2].map(n => ({ value: { list_id: uuid(n) } })) }; }
      if (sql.includes('enter_purchase_operation')) { captures++; time += 180000; }
      return { rows: [] };
    }, async close() { closed++; } };
  } });
  const first = await worker.recover();
  assert.equal(first.recalculations.length, 1); assert.equal(first.deadlineReached, true);
  assert.deepEqual(first.remaining, { recalculations: true, deliveries: true });
  await worker.recover();
  assert.deepEqual(cursors, [null, null]); assert.equal(captures, 2);
  assert.equal(opened, 2); assert.equal(closed, 2);
});

test('reserve gates channel claims and stops pages, leaving work durable', async () => {
  let time = 0, claims = 0, discovery = 0;
  const worker = purchaseWorker({ now: () => time, channels: {
    ntfy: async () => { time = 150001; return 'sent'; }, email: async () => assert.fail('no budget'),
  }, connect: async () => ({ async query(sql: string) {
    if (sql.includes('ORDER BY v.evaluated_at')) { discovery++; return { rows: [{ value: event(1) }, { value: event(2) }] }; }
    if (sql.includes('claim_purchase_delivery')) { claims++; return { rows: [{ value: notice }] }; }
    return { rows: [] };
  }, async close() {} }) });
  const report = await worker.recover();
  assert.equal(claims, 1); assert.equal(discovery, 1);
  assert.deepEqual(report.deliveries[0].outcomes, { ntfy: 'sent', email: 'deferred' });
  assert.equal(report.remaining.deliveries, true);
});

test('discovery/connect/close failures fail step; independent pending work still proceeds', async () => {
  for (const point of ['connect', 'discovery', 'close']) {
    let opened = 0, closed = 0;
    const worker = purchaseWorker({ now: () => 0, channels, connect: async () => {
      const attempt = ++opened;
      if (attempt === 1 && point === 'connect') throw Error(point);
      return { async query() { if (attempt === 1 && point === 'discovery') throw Error(point); return { rows: [] }; },
        async close() { closed++; if (attempt === 1 && point === 'close') throw Error(point); } };
    } });
    await assert.rejects(worker.recover(), error => {
      assert.ok(error instanceof PurchaseWorkerError); assert.equal(error.failures.length, 1); return true;
    });
    assert.equal(opened, 2); assert.equal(closed, point === 'connect' ? 1 : 2);
    assert.deepEqual((await worker.recover()).recalculations, []); assert.equal(opened, 4);
  }
});

test('receipt acknowledgement failures fail worker, continue other channel and close sessions', async () => {
  let sends = 0, closed = 0;
  const send = async () => { sends++; return 'sent' as const; };
  const worker = purchaseWorker({ now: () => 0, channels: { ntfy: send, email: send }, connect: async () => ({
    async query(sql: string, args: unknown[] = []) {
      if (sql.includes('ORDER BY v.evaluated_at')) return { rows: [{ value: event(1) }] };
      if (sql.includes('claim_purchase_delivery')) return { rows: [{ value: notice }] };
      if (sql.includes('finish_purchase_delivery') && args[1] === 'ntfy') throw Error('lost finish');
      return { rows: [] };
    }, async close() { closed++; },
  }) });
  await assert.rejects(worker.recover(), error => {
    assert.ok(error instanceof PurchaseWorkerError);
    assert.deepEqual(error.report.deliveries[0].outcomes, { ntfy: 'unrecorded', email: 'sent' }); return true;
  });
  assert.equal(sends, 2); assert.equal(closed, 2);
});

test('overlap coalesces with fresh capture, original deadline bounds continuous callbacks', async () => {
  let time = 0, opened = 0, closed = 0, release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  const worker = purchaseWorker({ now: () => time, channels, connect: async () => {
    const attempt = ++opened;
    return { async query() { if (attempt === 1) { entered(); await pause; }
      if (attempt === 3) { worker.afterProductReview(); time = 180000; } return { rows: [] }; },
      async close() { closed++; } };
  } });
  const first = worker.afterProductReview(); await ready;
  assert.equal(worker.afterProductReview(), first); assert.equal(worker.recover(), first);
  release(); const report = await first;
  assert.equal(opened, 3); assert.equal(closed, 3); assert.equal(report.deadlineReached, true);
  assert.deepEqual(report.remaining, { recalculations: true, deliveries: true });
});

test('hung sender times out, aborts, records ambiguity and continues independent channel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined, calls = 0;
  const statuses: unknown[] = [];
  const db = { async query(sql: string, args: unknown[] = []) {
    if (sql.includes('finish_purchase_delivery')) statuses.push(args[2]);
    return { rows: sql.includes('claim_purchase_delivery') ? [{ value: notice }] : [] };
  } };
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const result = deliverPurchaseNoticeLocally(db, uuid(1), {
    ntfy: async (_notice, context) => { signal = context.signal; entered(); return new Promise(() => {}); },
    email: async () => { calls++; return 'failed'; },
  });
  await ready; t.mock.timers.tick(15000);
  assert.deepEqual(await result, { ntfy: 'ambiguous', email: 'failed' });
  assert.equal(signal?.aborted, true); assert.equal(calls, 1); assert.deepEqual(statuses, ['ambiguous', 'failed']);
});

test('connection failure during basket capture fails run after independent delivery sweep', async () => {
  let deliveriesDiscovered = false, closed = 0;
  const worker = purchaseWorker({ now: () => 0, channels, connect: async () => ({
    async query(sql: string) {
      if (sql.includes('ORDER BY l.id')) return { rows: [{ value: { list_id: uuid(1) } }] };
      if (sql.includes('enter_purchase_operation')) throw Object.assign(Error('disconnected'), { code: '08006' });
      if (sql.includes('ORDER BY v.evaluated_at')) deliveriesDiscovered = true;
      return { rows: [] };
    }, async close() { closed++; },
  }) });
  await assert.rejects(worker.recover(), error => {
    assert.ok(error instanceof PurchaseWorkerError); assert.equal(error.report.recalculations[0].status, 503); return true;
  });
  assert.equal(deliveriesDiscovered, true); assert.equal(closed, 2);
});

test('budget consumed by claim prevents transport, conservatively records ambiguity', async () => {
  let allowed = true; const statuses: unknown[] = [];
  const db = { async query(sql: string, args: unknown[] = []) {
    if (sql.includes('claim_purchase_delivery')) { allowed = false; return { rows: [{ value: notice }] }; }
    if (sql.includes('finish_purchase_delivery')) statuses.push(args[2]);
    return { rows: [] };
  } };
  const send = async (): Promise<'sent'> => assert.fail('no time to send');
  assert.deepEqual(await deliverPurchaseNoticeLocally(db, uuid(1), { ntfy: send, email: send }, { canClaim: () => allowed }),
    { ntfy: 'ambiguous', email: 'deferred' });
  assert.deepEqual(statuses, ['ambiguous']);
});
