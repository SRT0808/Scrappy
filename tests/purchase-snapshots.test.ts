import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, capturePurchaseSnapshot, replayPurchaseSnapshot } from '../lib/server/purchase-snapshots.js';
import type { PurchaseInput } from '../lib/server/purchase-engine.js';
import { runPurchaseReplay } from '../scripts/purchase-replay.js';

test('unsupported currency exclusion survives archived replay without losing valid purchases', () => {
  const input = fixture();
  input.offers.push({ ...structuredClone(input.offers[0]), id: 'unsupported', currency: 'EUR' });
  input.alternatives.push({ id: 'unsupported', scope: [...input.alternatives[0].scope], items: [{ offerId: 'unsupported', purchaseUnits: '2' }] });
  const snapshot = capture(input);
  assert.equal(snapshot.result.recommendation.coverageComplete, true);
  assert.equal(snapshot.result.recommendation.comparisonComplete, false);
  assert.ok(snapshot.result.exclusions.some(e => e.reason === 'unsupported_currency'));
  assert.deepEqual(replayPurchaseSnapshot(JSON.parse(canonicalJson(snapshot))), snapshot);
});

function fixture(): PurchaseInput {
  return {
    configurationVersion: '9007199254740993', evaluatedAt: '2026-10-16T12:00:00Z', currency: 'PEN',
    needs: [{ id: 'water', quantity: '1000', unit: 'ml' }],
    offers: [{ id: 'bottle', productId: 'tracked', price: '0.123456789012345678', currency: 'USD', confirmed: true,
      available: true, suspicious: false, pendingFailure: false, priceCheckId: 'check-1', lastSuccessAt: '2026-10-15T12:00:00Z',
      coverage: [{ needId: 'water', quantity: '500', unit: 'ml' }], extras: [{ id: 'gift', quantity: '1', unit: 'unit', accepted: true }] }],
    alternatives: [{ id: 'two-bottles', scope: ['water'], items: [{ offerId: 'bottle', purchaseUnits: '2' }] }],
    pins: ['two-bottles'], reference: ['two-bottles'], previousEffective: [{ offerId: 'bottle', purchaseUnits: '2' }],
    fx: { multiplier: '3.333333333333333333', from: 'USD', to: 'PEN', date: '2026-10-16', source: 'local-fixture', fetchedAt: '2026-10-16T11:00:00Z' },
  };
}
const capture = (input = fixture(), listId = 'basket-a', maxNodes = 100000) => capturePurchaseSnapshot(listId, input, { now: () => 0, maxNodes });
const transport = <T>(value: T): T => JSON.parse(canonicalJson(value));
function resign<T extends { checksum: string }>(snapshot: T): T {
  const { checksum: _checksum, ...body } = snapshot;
  return { ...snapshot, checksum: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

test('lossless serialized replay preserves full inputs, decimals, FX, charges and provenance', () => {
  const snapshot = capture(), bytes = canonicalJson(snapshot);
  assert.equal(snapshot.result.effective.total, '0.82');
  assert.equal(snapshot.configuration_version, '9007199254740993');
  assert.equal(canonicalJson(replayPurchaseSnapshot(JSON.parse(bytes))), bytes);
  assert.equal(snapshot.inputs.offers[0].priceCheckId, 'check-1');
  assert.equal(snapshot.inputs.fx?.multiplier, '3.333333333333333333');
  assert.equal(snapshot.result.effective.purchases[0].extras[0].quantity, '2.000000');
  assert.ok(Object.isFrozen(snapshot.inputs.offers[0].coverage[0]));
});

test('versions and baskets remain independent after configuration and product mutations', () => {
  const input = fixture(), first = capture(input), before = canonicalJson(first);
  input.configurationVersion = '9007199254740994'; input.offers[0].price = '10'; input.needs[0].quantity = '500';
  input.alternatives[0].items[0].purchaseUnits = '1'; input.previousEffective = []; input.pins = [];
  const second = capture(input), other = capture(input, 'basket-b');
  assert.notEqual(first.input_signature, second.input_signature);
  assert.notEqual(second.input_signature, other.input_signature);
  assert.equal(canonicalJson(replayPurchaseSnapshot(first)), before);
  assert.equal(replayPurchaseSnapshot(second).result.effective.total, '33.33');
  assert.equal(canonicalJson(first), before);
});

test('signature includes excluded states, check provenance, previous ties, limits and Lima validity date', () => {
  const original = capture();
  const sameDay = fixture(); sameDay.evaluatedAt = '2026-10-17T04:59:59Z';
  assert.equal(capture(sameDay).input_signature, original.input_signature);
  sameDay.evaluatedAt = '2026-10-17T05:00:00Z';
  assert.notEqual(capture(sameDay).input_signature, original.input_signature);
  for (const mutate of [
    (i: PurchaseInput) => { i.offers[0].pendingFailure = true; },
    (i: PurchaseInput) => { i.offers[0].priceCheckId = 'check-2'; },
    (i: PurchaseInput) => { i.previousEffective = []; },
    (i: PurchaseInput) => { i.fx!.source = 'another-source'; },
  ]) {
    const input = fixture(); mutate(input); const changed = capture(input);
    assert.notEqual(changed.input_signature, original.input_signature);
    assert.deepEqual(replayPurchaseSnapshot(transport(changed)), changed);
  }
  assert.notEqual(capture(fixture(), 'basket-a', 1).input_signature, original.input_signature);
});

test('node and deadline interruptions replay identically without upgrading optimality', () => {
  const nodeCut = capture(fixture(), 'basket-a', 1);
  assert.equal(nodeCut.result.recommendation.limitReason, 'node_limit');
  assert.deepEqual(replayPurchaseSnapshot(transport(nodeCut)), nodeCut);
  let tick = 0;
  const timed = capturePurchaseSnapshot('basket-a', fixture(), { now: () => tick++, deadlineMs: 1 });
  assert.equal(timed.result.recommendation.limitReason, 'deadline');
  assert.equal(timed.result.effective.optimality, 'unproven');
  assert.deepEqual(replayPurchaseSnapshot(transport(timed)), timed);
});

test('tampering, unknown versions, forged results and malformed clock traces are rejected', () => {
  const original = transport(capture());
  const tampered = transport(original); tampered.inputs.offers[0].price = '999';
  assert.throws(() => replayPurchaseSnapshot(tampered), /checksum/);
  for (const patch of [{ snapshot_version: 99 }, { schema_version: 3 }, { engine_version: 'future-engine' }]) {
    assert.throws(() => replayPurchaseSnapshot({ ...original, ...patch }), /unsupported_snapshot_version/);
  }
  const forged = transport(original); forged.result.effective.total = '999.00';
  assert.throws(() => replayPurchaseSnapshot(resign(forged)), /replay_mismatch/);
  assert.throws(() => replayPurchaseSnapshot(resign({ ...original, configuration_version: '2' })), /replay_mismatch/);
  assert.throws(() => replayPurchaseSnapshot(resign({ ...original, clock: [] })), /clock_exhausted/);
  assert.throws(() => replayPurchaseSnapshot(resign({ ...original, clock: [...original.clock, 0] })), /replay_mismatch/);
  assert.throws(() => capture({ ...fixture(), secret: 'must-not-be-archived' } as PurchaseInput), /fields/);
});

test('local JSON boundary rejects coercible flags, absent fields and nested secrets', () => {
  for (const patch of [{ confirmed: 'false' }, { pendingFailure: null }, { priceCheckId: undefined }, { recipe: 'private' }]) {
    const input = fixture(); Object.assign(input.offers[0], patch);
    assert.throws(() => capture(input), /invalid_snapshot/);
  }
  const input = fixture(); Object.assign(input.fx!, { multiplier: 3.33 });
  assert.throws(() => capture(input), /invalid_snapshot/);
});

test('canonical collection order and object key order do not change snapshots', () => {
  const input = fixture();
  input.needs.push({ id: 'absent', quantity: '1', unit: 'unit' });
  const first = capture(input);
  input.needs.reverse();
  input.offers[0] = Object.fromEntries(Object.entries(input.offers[0]).reverse()) as PurchaseInput['offers'][number];
  assert.deepEqual(capture(input), first);
});

test('local CLI persists separate files, refuses overwrite and replays in a fresh process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrappy-purchase-'));
  try {
    const inputPath = join(directory, 'input.json'), outputPath = join(directory, 'v1.json');
    await writeFile(inputPath, canonicalJson({ list_id: 'basket-a', inputs: fixture() }));
    await runPurchaseReplay(['capture', inputPath, outputPath]);
    const before = await readFile(outputPath, 'utf8');
    await assert.rejects(runPurchaseReplay(['capture', inputPath, outputPath]), /EEXIST/);
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/purchase-replay.js', import.meta.url)), 'replay', outputPath], { encoding: 'utf8' });
    assert.match(output, /Replay idéntico verificado/);
    const changed = fixture(); changed.configurationVersion = '9007199254740994'; changed.offers[0].available = false;
    await writeFile(inputPath, canonicalJson({ list_id: 'basket-a', inputs: changed }));
    await runPurchaseReplay(['capture', inputPath, join(directory, 'v2.json')]);
    assert.equal(await readFile(outputPath, 'utf8'), before);
    assert.match(await runPurchaseReplay(['replay', outputPath]), /idéntico/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
