import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePurchaseSnapshot, canonicalJson } from '../lib/server/purchase-snapshots.js';
import { commitPurchaseEvaluation, mutatePurchaseSources, savePurchaseConfiguration, purchaseDay, purchaseErrorStatus, purchaseHash, validatePurchaseCapture, validatePurchaseCommit, type PurchaseCapture, type PurchaseConnection } from '../lib/server/purchase-persistence.js';
import type { PurchaseInput } from '../lib/server/purchase-engine.js';

const id = '10000000-0000-0000-0000-000000000001';
function fixture() {
  const inputs: PurchaseInput = { configurationVersion: '1', evaluatedAt: '2026-10-16T12:00:00Z', currency: 'PEN', needs: [], offers: [], alternatives: [], previousRecommendation: [], previousEffective: [] };
  const body = { token_version: 1 as const, list_id: id, configuration_version: '1', input_revision: '0', state_revision: '0', mode: 'alternatives' as const,
    evaluated_at: inputs.evaluatedAt, validity_date: '2026-10-16', source_fingerprint: 'a'.repeat(64), engine_version: 'purchase-cover-v1' as const,
    limits: { maxNodes: 100000, deadlineMs: 2000 }, previous_recommendation: [], previous_effective: [] };
  const capture: PurchaseCapture = { ...body, capture_signature: purchaseHash(body) };
  return { capture, snapshot: capturePurchaseSnapshot(id, inputs, { now: () => 0 }) };
}
const validate = (p: ReturnType<typeof fixture>) => validatePurchaseCommit(id, '1', p.capture.capture_signature, p);
test('canonical capture and distinct persistence identity preserve archive signature on ABA', () => {
  const p = fixture(), original = validate(p);
  assert.equal(purchaseHash({ b: 2, a: 1 }), purchaseHash({ a: 1, b: 2 }));
  p.capture.input_revision = '2';
  const { capture_signature: _, ...body } = p.capture; p.capture.capture_signature = purchaseHash(body);
  const after = validate(p);
  assert.notEqual(after.persistence_signature, original.persistence_signature);
  assert.equal(after.snapshot.input_signature, original.snapshot.input_signature);
  assert.equal(canonicalJson(after.snapshot), canonicalJson(original.snapshot));
});
test('reject unknown fields, numeric revisions, unsupported limits/versions and wrong day', () => {
  for (const patch of [{ extra: true }, { input_revision: 0 }, { token_version: 2 }, { configuration_version: '01' }, { state_revision: '9223372036854775808' }, { validity_date: '2026-10-17' }, { limits: { maxNodes: 1, deadlineMs: 2000 } }]) {
    assert.throws(() => validatePurchaseCapture({ ...fixture().capture, ...patch }));
  }
  const p = fixture(); p.capture.state_revision = '1'; assert.throws(() => validate(p), /signature/);
});
test('reject mixed basket/version/time/ties, altered archives and extra payload fields', () => {
  const p = fixture();
  for (const inputs of [{ ...p.snapshot.inputs, evaluatedAt: '2026-10-16T13:00:00Z' }, { ...p.snapshot.inputs, configurationVersion: '2' }, { ...p.snapshot.inputs, previousEffective: [{ offerId: 'x', purchaseUnits: '1' }] }]) {
    assert.throws(() => validate({ capture: p.capture, snapshot: capturePurchaseSnapshot(id, inputs, { now: () => 0 }) }), /mismatch/);
  }
  assert.throws(() => validate({ ...p, snapshot: capturePurchaseSnapshot('another', p.snapshot.inputs, { now: () => 0 }) }));
  assert.throws(() => validatePurchaseCommit(id, '1', p.capture.capture_signature, { ...p, browser: true }));
  assert.throws(() => validate({ ...p, snapshot: { ...p.snapshot, result: { ...p.snapshot.result, engineVersion: 'tampered' } } }));
});
test('Lima midnight and retry/status semantics have explicit boundaries', () => {
  assert.equal(purchaseDay('2026-10-17T04:59:59Z'), '2026-10-16');
  assert.equal(purchaseDay('2026-10-17T05:00:00Z'), '2026-10-17');
  for (const code of ['40001', '40P01', 'PT409']) assert.equal(purchaseErrorStatus({ code }), 409);
  for (const code of ['55P03', '08006', '57014']) assert.equal(purchaseErrorStatus({ code }), 503);
  assert.equal(purchaseErrorStatus({ code: 'PT404' }), 404);
  assert.equal(purchaseErrorStatus({ code: 'PT400' }), 400);
});
test('trusted adapter validates before SQL and rolls back a conflict without retry', async () => {
  const calls: string[] = [], p = fixture();
  const db: PurchaseConnection = { async query(sql) { calls.push(sql); if (sql.startsWith('SELECT')) throw Object.assign(new Error('race'), { code: '40001' }); return { rows: [] }; } };
  await assert.rejects(commitPurchaseEvaluation(db, id, '1', p.capture.capture_signature, { ...p, extra: true }));
  assert.equal(calls.length, 0);
  await assert.rejects(commitPurchaseEvaluation(db, id, '1', p.capture.capture_signature, p), /race/);
  assert.deepEqual(calls.map(s => s.split(' ')[0]), ['BEGIN', 'SELECT', 'ROLLBACK']);
});
test('source wrapper enters gate before work and coalesces all dependencies into one invalidation', async () => {
  const calls: string[] = [], parameters: unknown[][] = [];
  const db: PurchaseConnection = { async query(sql, args = []) { calls.push(sql); parameters.push(args); return { rows: [] }; } };
  await mutatePurchaseSources(db, async () => { calls.push('SOURCE'); }, [id, id], true, [id]);
  assert.deepEqual(calls.map(s => s.split(' ')[0]), ['BEGIN', 'SELECT', 'SOURCE', 'SELECT', 'COMMIT']);
  assert.match(calls[1], /enter_purchase_operation/); assert.match(calls[3], /invalidate_purchase_inputs/);
  assert.deepEqual(parameters[2], [[id, id], true, [id]]);
});

test('publication adapter preserves exact version/decimals, commits once and never retries conflicts', async () => {
  const calls: { sql: string; args: unknown[] }[] = [];
  let conflict = false;
  const db: PurchaseConnection = { async query(sql, args = []) {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT') && conflict) throw Object.assign(new Error('stale'), { code: '40001' });
    return { rows: [{ value: { version: '9007199254740993' } }] };
  } };
  const config = { budget: '9999999999.99', needs: [] };
  assert.deepEqual(await savePurchaseConfiguration(db, id, '9007199254740992', config), { version: '9007199254740993' });
  assert.deepEqual(calls.map(c => c.sql.split(' ')[0]), ['BEGIN', 'SELECT', 'COMMIT']);
  assert.deepEqual(calls[1].args, [id, '9007199254740992', canonicalJson(config)]);
  calls.length = 0; conflict = true;
  await assert.rejects(savePurchaseConfiguration(db, id, '1', config), { code: '40001' });
  assert.deepEqual(calls.map(c => c.sql.split(' ')[0]), ['BEGIN', 'SELECT', 'ROLLBACK']);
});
