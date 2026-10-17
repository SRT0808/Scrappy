import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePurchases, normalizeQuantity, type PurchaseInput, type Offer, type Alternative } from '../lib/server/purchase-engine.js';
const offer = (id: string, price: string, coverage: Offer['coverage'], more: Partial<Offer> = {}): Offer => ({ id, productId: id, price, currency: 'PEN', confirmed: true, available: true, pendingFailure: false, suspicious: false, priceCheckId: 'check', lastSuccessAt: '2026-10-16T10:00:00Z', coverage, ...more });
const alt = (id: string, scope: string[], items: [string, string][]): Alternative => ({ id, scope, items: items.map(([offerId, purchaseUnits]) => ({ offerId, purchaseUnits })) });
function fixture(): PurchaseInput {
  return { configurationVersion: '1', evaluatedAt: '2026-10-16T12:00:00Z', currency: 'PEN',
    needs: [{ id: 'water', quantity: '1000', unit: 'ml' }, { id: 'cookies', quantity: '1', unit: 'unit' }],
    offers: [offer('water', '1.30', [{ needId: 'water', quantity: '500', unit: 'ml' }]), offer('cookies', '2.70', [{ needId: 'cookies', quantity: '1', unit: 'unit' }]), offer('combo', '5', [{ needId: 'water', quantity: '1000', unit: 'ml' }, { needId: 'cookies', quantity: '1', unit: 'unit' }])],
    alternatives: [alt('water', ['water'], [['water', '2']]), alt('cookies', ['cookies'], [['cookies', '1']]), alt('combo', ['water', 'cookies'], [['combo', '1']])] };
}
const evaluate = (input: PurchaseInput, maxNodes = 100000) => evaluatePurchases(input, { now: () => 0, maxNodes });

test('unsupported offer currencies exclude only dependent alternatives, retain pins and allow recovery', () => {
  const input = fixture(); input.pins = ['combo']; input.reference = ['combo'];
  input.offers[2].currency = 'EUR';
  const result = evaluate(input);
  assert.equal(result.recommendation.total, '5.30');
  assert.equal(result.recommendation.optimality, 'verified_subset');
  assert.equal(result.effective.total, null);
  assert.equal(result.effective.invalidPin, true);
  assert.equal(result.effectiveSavings.amount, null);
  assert.deepEqual(result.exclusions, [{ alternativeId: 'combo', offerId: 'combo', reason: 'unsupported_currency' }]);
  input.pins = []; input.reference = []; input.alternatives.pop();
  assert.equal(evaluate(input).effective.total, '5.30');
  assert.equal(evaluate(input).effective.comparisonComplete, true); // unused draft offer
  input.alternatives = fixture().alternatives; input.offers[2].currency = 'PEN';
  assert.equal(evaluate(input).effective.total, '5.00');
  input.offers.forEach(o => { o.currency = 'EUR'; });
  assert.equal(evaluate(input).effective.total, null);
  assert.equal(evaluate(input).effective.optimality, 'infeasible');
});
test('global cover charges a shared combo once; pins and reference remain independent', () => {
  const input = fixture(); input.pins = ['water']; input.reference = ['water', 'cookies'];
  const result = evaluate(input);
  assert.equal(result.recommendation.total, '5.00'); assert.equal(result.effective.total, '5.30');
  assert.equal(result.recommendation.purchases.length, 1); assert.equal(result.recommendationSavings.amount, '0.30');
  assert.equal(result.recommendationSavings.percent, '5.66');
  input.pins = ['combo', 'water']; assert.throws(() => evaluate(input), /incompatible/);
});
test('packs, repetitions, aggregate limits, surplus, extras and incompatible units', () => {
  const input = fixture(); input.needs = [input.needs[0]]; input.offers = [input.offers[0]]; input.alternatives = [input.alternatives[0]];
  assert.equal(evaluate(input).effective.total, '2.60');
  input.offers[0].maxPurchaseUnits = '1'; assert.equal(evaluate(input).effective.total, null);
  delete input.offers[0].maxPurchaseUnits; input.offers[0].coverage[0].quantity = '750';
  assert.throws(() => evaluate(input), /coverage/); input.needs[0].allowSurplus = true;
  assert.equal(evaluate(input).effective.coverageComplete, true);
  input.offers[0].extras = [{ id: 'juice', quantity: '1', unit: 'unit', accepted: false }];
  assert.equal(evaluate(input).effective.total, null); input.offers[0].extras[0].accepted = true;
  input.offers[0].coverage[0].unit = 'g'; assert.throws(() => evaluate(input), /coverage/);
  assert.deepEqual(normalizeQuantity('0.5', 'L'), { quantity: '500', unit: 'ml' });
  assert.deepEqual(normalizeQuantity('0.000000001', 'kg'), { quantity: '0.000001', unit: 'g' });
  assert.throws(() => normalizeQuantity('0.0000000001', 'kg'), /quantity/);
  assert.throws(() => normalizeQuantity('1.2', 'unit'), /quantity/);
});
test('decimal FX, aggregate rounding, zero reference and unrounded ties', () => {
  const input = fixture(); input.offers[0].price = '0.005'; input.offers[1].price = '0.005'; input.offers[2].price = '0.016';
  assert.equal(evaluate(input).effective.total, '0.02');
  assert.deepEqual(evaluate(input).effective.alternativeIds, ['cookies', 'water']);
  input.offers[0].currency = 'USD'; input.fx = { multiplier: '3.333333333333333333', from: 'USD', to: 'PEN', date: '2026-10-11', source: 'fixture', fetchedAt: input.evaluatedAt };
  assert.equal(evaluate(input).effective.total, '0.02');
  input.fx.date = '2026-10-10'; assert.equal(evaluate(input).effective.optimality, 'verified_subset');
  input.offers.forEach(o => { o.price = '0'; o.currency = 'PEN'; }); input.reference = ['combo'];
  assert.equal(evaluate(input).recommendationSavings.percent, null);
  input.previousEffective = [{ offerId: 'combo', purchaseUnits: '1' }];
  assert.deepEqual(evaluate(input).effective.alternativeIds, ['combo']);
});
test('invalid pinned offer is retained without silent replacement; verified subset and recovery', () => {
  const input = fixture(); input.pins = ['combo']; input.offers[2].pendingFailure = true;
  let result = evaluate(input);
  assert.equal(result.recommendation.total, '5.30'); assert.equal(result.recommendation.optimality, 'verified_subset');
  assert.equal(result.effective.total, null); assert.equal(result.effective.invalidPin, true);
  assert.deepEqual(result.effective.pendingNeedIds.sort(), ['cookies', 'water']);
  assert.deepEqual(result.effective.purchases, []);
  assert.deepEqual(result.effective.pinnedAlternativeIds, ['combo']);
  input.offers[2].pendingFailure = false; result = evaluate(input); assert.equal(result.effective.total, '5.00');
  for (const changes of [{ confirmed: false }, { available: false }, { suspicious: true }, { price: null }, { priceCheckId: null }]) {
    Object.assign(input.offers[2], changes); assert.equal(evaluate(input).effective.total, null);
    input.offers[2] = fixture().offers[2];
  }
});
test('node boundary, deadline, empty/no solution and named configuration bounds', () => {
  const input = fixture(), full = evaluate(input), nodes = full.recommendation.visitedNodes;
  assert.equal(evaluate(input, nodes).recommendation.searchComplete, true);
  const cut = evaluate(input, nodes - 1).recommendation;
  assert.equal(cut.optimality, 'unproven'); assert.equal(cut.limitReason, 'node_limit');
  let tick = 0; const timed = evaluatePurchases(input, { now: () => tick++, deadlineMs: 1 });
  assert.equal(timed.effective.limitReason, 'deadline');
  const empty = evaluate({ ...input, needs: [], offers: [], alternatives: [] }).effective;
  assert.equal(empty.total, null); assert.equal(empty.coverageComplete, false);
  input.alternatives = []; assert.equal(evaluate(input).effective.optimality, 'infeasible');
  assert.throws(() => evaluate({ ...input, needs: Array.from({ length: 33 }, (_, i) => ({ id: String(i), quantity: '1', unit: 'unit' })) }), /configuration_limit/);
  assert.throws(() => evaluatePurchases(fixture(), { maxNodes: 100001 }), /limits/);
});
test('small exhaustive independent oracle agrees on all subsets with overlaps and aggregate limits', () => {
  let seed = 913;
  const random = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 200; trial++) {
    const needs: PurchaseInput['needs'] = Array.from({ length: 3 }, (_, i) => ({ id: String(i), quantity: '1', unit: 'unit' }));
    const offers: Offer[] = [], alternatives: Alternative[] = [];
    for (let a = 0; a < 7; a++) {
      const mask = 1 + random(7), scope = needs.filter((_, i) => mask & (1 << i)).map(n => n.id), id = String(a);
      offers.push(offer(id, `${random(500)}.${String(random(10000)).padStart(4, '0')}`, scope.map(needId => ({ needId, quantity: '1', unit: 'unit' })), { maxPurchaseUnits: String(1 + random(2)) }));
      alternatives.push(alt(id, scope, [[id, '1']]));
    }
    offers.push(offer('7', '0.0001', [], { maxPurchaseUnits: String(1 + random(3)) }));
    for (const choice of alternatives) choice.items.push({ offerId: '7', purchaseUnits: String(1 + random(2)) });
    // Reuse an offer in a second declared alternative to exercise summed limits.
    alternatives.push({ ...alternatives[0], id: 'duplicate' });
    const input: PurchaseInput = { ...fixture(), needs, offers, alternatives };
    let minimum: bigint | null = null;
    for (let subset = 0; subset < 1 << alternatives.length; subset++) {
      let mask = 0, valid = true, cents = 0n; const counts = new Map<string, number>();
      for (let a = 0; a < alternatives.length; a++) if (subset & (1 << a)) {
        const choice = alternatives[a], choiceMask = choice.scope.reduce((m, id) => m | (1 << Number(id)), 0);
        if (mask & choiceMask) valid = false; mask |= choiceMask;
        for (const item of choice.items) {
          const index = Number(item.offerId), n = (counts.get(item.offerId) ?? 0) + Number(item.purchaseUnits); counts.set(item.offerId, n);
          if (n > Number(offers[index].maxPurchaseUnits)) valid = false;
          cents += BigInt(offers[index].price!.replace('.', '')) * BigInt(item.purchaseUnits);
        }
      }
      if (valid && mask === 7 && (minimum === null || cents < minimum)) minimum = cents;
    }
    const result = evaluate(input).effective;
    const rounded = minimum === null ? null : (minimum + 50n) / 100n;
    assert.equal(result.total, rounded === null ? null : `${rounded / 100n}.${String(rounded % 100n).padStart(2, '0')}`, `trial ${trial}`);
    assert.equal(result.searchComplete, true);
    const limited = evaluate(input, 2).effective;
    assert.ok(limited.visitedNodes <= 2);
    if (!limited.searchComplete) assert.equal(limited.optimality, 'unproven');
    if (limited.total !== null) {
      assert.notEqual(rounded, null);
      assert.ok(BigInt(limited.total.replace('.', '')) >= rounded!);
    }
  }
});

test('all declared size boundaries and integer counts reject overflow without truncation', () => {
  const input = fixture();
  input.needs = Array.from({ length: 32 }, (_, i) => ({ id: String(i), quantity: '1', unit: 'unit' }));
  input.offers = Array.from({ length: 64 }, (_, i) => offer(String(i), '0.01', i < 32 ? [{ needId: String(i), quantity: '1', unit: 'unit' }] : []));
  input.offers[0].extras = Array.from({ length: 32 }, (_, i) => ({ id: String(i), quantity: '1', unit: 'unit', accepted: true }));
  input.alternatives = Array.from({ length: 128 }, (_, i) => alt(String(i), input.needs.map(n => n.id), input.offers.slice(0, 32).map(o => [o.id, '1'])));
  assert.equal(evaluate(input).effective.total, '0.32');
  input.alternatives.push({ ...input.alternatives[0], id: 'overflow' }); assert.throws(() => evaluate(input), /configuration_limit/); input.alternatives.pop();
  input.offers.push(offer('overflow', '1', [])); assert.throws(() => evaluate(input), /configuration_limit/); input.offers.pop();
  input.offers[0].extras.push({ id: 'overflow', quantity: '1', unit: 'unit', accepted: true }); assert.throws(() => evaluate(input), /configuration_limit/); input.offers[0].extras.pop();
  input.alternatives[0].items.push({ offerId: '32', purchaseUnits: '1' }); assert.throws(() => evaluate(input), /size/);
  const large = fixture(); large.needs = [{ id: 'water', quantity: '2147483647', unit: 'ml' }];
  large.offers = [offer('water', '0.000001', [{ needId: 'water', quantity: '1', unit: 'ml' }])];
  large.alternatives = [alt('water', ['water'], [['water', '2147483647']])];
  assert.equal(evaluate(large).effective.total, '2147.48');
  large.alternatives[0].items[0].purchaseUnits = '2147483648'; assert.throws(() => evaluate(large), /count/);
});
test('negative reference savings, previous ties and immutable caller inputs', () => {
  const input = fixture(); input.reference = ['combo']; input.pins = ['water'];
  const before = JSON.stringify(input), result = evaluate(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.effectiveSavings.amount, '-0.30'); assert.equal(result.effectiveSavings.percent, '-6.00');
  input.offers[2].price = '5.30';
  const canonical = evaluate(input).effective.alternativeIds;
  input.offers.reverse(); input.alternatives.reverse(); input.needs.reverse();
  assert.deepEqual(evaluate(input).effective.alternativeIds, canonical);
});

test('incomplete purchases expose known partial coverage, and invalid references give no savings', () => {
  const input = fixture(); input.alternatives = input.alternatives.filter(a => a.id !== 'combo');
  input.offers[0].pendingFailure = true;
  const result = evaluate(input).effective;
  assert.equal(result.total, null); assert.equal(result.knownSubtotal, '2.70');
  assert.deepEqual(result.pendingNeedIds, ['water']);
  const overlap = fixture(); overlap.reference = ['combo', 'water'];
  assert.equal(evaluate(overlap).effectiveSavings.amount, null);
  assert.equal(evaluate(overlap).reference?.coverageComplete, false);
});

test('four bottles compare whole pack prices; supplied reciprocal FX stays exact', () => {
  const input: PurchaseInput = { ...fixture(), needs: [{ id: 'bottles', quantity: '4', unit: 'unit' }],
    offers: [offer('single', '2.80', [{ needId: 'bottles', quantity: '1', unit: 'unit' }]), offer('pack', '12', [{ needId: 'bottles', quantity: '4', unit: 'unit' }])],
    alternatives: [alt('single', ['bottles'], [['single', '4']]), alt('pack', ['bottles'], [['pack', '1']])], reference: ['pack'] };
  assert.equal(evaluate(input).effective.total, '11.20');
  assert.equal(evaluate(input).effectiveSavings.amount, '0.80');
  input.currency = 'USD'; input.fx = { from: 'PEN', to: 'USD', multiplier: '0.266666666666666666', date: '2026-10-11', source: 'fixture', fetchedAt: input.evaluatedAt };
  const result = evaluate(input);
  assert.equal(result.effective.total, '2.99');
  assert.equal(result.effective.purchases[0].convertedAmount, '2.98666666666666665920');
  assert.equal(result.effective.comparisonComplete, true);
});

test('SPEC 15: litre presentations and repeated two-bottle packs respect whole-purchase limits', () => {
  const water: PurchaseInput = { ...fixture(), needs: [{ id: 'water', quantity: '1000', unit: 'ml' }],
    offers: [offer('litre', '3', [{ needId: 'water', quantity: '1000', unit: 'ml' }]),
      offer('half', '1.30', [{ needId: 'water', quantity: '500', unit: 'ml' }])],
    alternatives: [alt('litre', ['water'], [['litre', '1']]), alt('halves', ['water'], [['half', '2']])], reference: ['litre'] };
  const result = evaluate(water);
  assert.equal(result.effective.total, '2.60');
  assert.equal(result.effectiveSavings.amount, '0.40');
  assert.equal(result.effective.coverage[0].covered, '1000.000000');
  assert.deepEqual(result.effective.purchases.map(p => [p.offerId, p.purchaseUnits]), [['half', '2']]);

  const packs: PurchaseInput = { ...fixture(), needs: [{ id: 'bottles', quantity: '4', unit: 'unit' }],
    offers: [offer('pack', '5', [{ needId: 'bottles', quantity: '2', unit: 'unit' }]),
      offer('single', '2.80', [{ needId: 'bottles', quantity: '1', unit: 'unit' }])],
    alternatives: [alt('packs', ['bottles'], [['pack', '2']]), alt('singles', ['bottles'], [['single', '4']])] };
  assert.equal(evaluate(packs).effective.total, '10.00');
  packs.offers[0].maxPurchaseUnits = '1';
  assert.equal(evaluate(packs).effective.total, '11.20');
  packs.alternatives.pop();
  const incomplete = evaluate(packs).effective;
  assert.equal(incomplete.total, null);
  assert.equal(incomplete.optimality, 'infeasible');
  assert.deepEqual(incomplete.pendingNeedIds, ['bottles']);
});

test('SPEC 15: failed combo and component states exclude only their dependent alternatives and recover', () => {
  const states: Partial<Offer>[] = [{ pendingFailure: true }, { suspicious: true }, { available: false },
    { confirmed: false }, { price: null, priceCheckId: null }, { currency: 'USD' }];
  for (const changes of states) {
    for (const failedId of ['combo', 'water']) {
      const input = fixture();
      Object.assign(input.offers.find(o => o.id === failedId)!, changes);
      if (changes.currency) input.fx = { from: 'USD', to: 'PEN', multiplier: '3.75', date: '2026-10-10',
        source: 'fixture', fetchedAt: input.evaluatedAt };
      const result = evaluate(input);
      assert.equal(result.recommendation.coverageComplete, true);
      assert.equal(result.recommendation.comparisonComplete, false);
      assert.equal(result.recommendation.optimality, 'verified_subset');
      assert.equal(result.recommendation.total, failedId === 'combo' ? '5.30' : '5.00');
      assert.deepEqual(result.exclusions.map(e => [e.alternativeId, e.offerId]), [[failedId, failedId]]);
      input.offers = fixture().offers;
      const recovered = evaluate(input);
      assert.equal(recovered.recommendation.total, '5.00');
      assert.equal(recovered.recommendation.optimality, 'verified_minimum');
      assert.deepEqual(recovered.exclusions, []);
    }
  }
});
