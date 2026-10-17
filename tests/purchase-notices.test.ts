import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverPurchaseNoticeLocally, purchaseNoticeMessage, type PurchaseNotice } from '../lib/server/purchase-notices.js';

const notice: PurchaseNotice = { reasons: 'both', currency: 'PEN', effective_total: '9.00', savings: '1.00',
  basket_path: '/?basket=fixture', offer_urls: [{ offer_id: 'a', url: 'https://example.test/a' }] };
test('Spanish combined message retains basket and offer links', () => {
  const message = purchaseNoticeMessage(notice);
  assert.match(message.message, /Presupuesto alcanzado: 9.00 PEN/);
  assert.match(message.message, /ahorro de 1.00 PEN a precios actuales/);
  assert.equal(message.basketPath, notice.basket_path); assert.deepEqual(message.offers, notice.offer_urls);
  assert.doesNotMatch(purchaseNoticeMessage({ ...notice, reasons: 'budget', savings: null }).message, /ahorro/);
  assert.doesNotMatch(purchaseNoticeMessage({ ...notice, reasons: 'winner' }).message, /Presupuesto/);
});
test('sender exceptions are ambiguous; definite failure still attempts the other channel', async () => {
  const statuses: unknown[][] = [], calls: string[] = [];
  const db = { async query(sql: string, parameters?: unknown[]) {
    if (sql.includes('finish_purchase_delivery')) statuses.push(parameters!);
    return { rows: sql.includes('claim_purchase_delivery') ? [{ value: notice }] : [] };
  } };
  assert.deepEqual(await deliverPurchaseNoticeLocally(db, 'event', {
    ntfy: async () => { calls.push('ntfy'); throw Error('uncertain'); },
    email: async () => { calls.push('email'); return 'failed'; },
  }), { ntfy: 'ambiguous', email: 'failed' });
  assert.deepEqual(calls, ['ntfy', 'email']);
  assert.deepEqual(statuses, [['event', 'ntfy', 'ambiguous'], ['event', 'email', 'failed']]);
});
test('unclaimed deliveries cannot invoke a sender', async () => {
  const db = { async query() { return { rows: [{ value: null }] }; } };
  const send = async (): Promise<'sent'> => { assert.fail('duplicate delivery'); };
  assert.deepEqual(await deliverPurchaseNoticeLocally(db, 'event', { ntfy: send, email: send }), { ntfy: 'unclaimed', email: 'unclaimed' });
});
