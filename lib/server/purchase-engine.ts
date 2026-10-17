/** Isolated evaluator: no storage, network, activation or notification side effects. */
export const ENGINE_VERSION = 'purchase-cover-v1';
const MAX_COUNT = 2147483647n;
type Unit = 'ml' | 'g' | 'unit';
type Money = { n: bigint; scale: number };
function decimal(value: string): Money {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || value.length > 128) throw new Error('invalid_decimal');
  const [whole, fraction = ''] = value.split('.');
  return { n: BigInt(whole + fraction), scale: fraction.length };
}
function add(a: Money, b: Money): Money {
  const scale = Math.max(a.scale, b.scale);
  return { n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale), scale };
}
function compare(a: Money, b: Money) { return add(a, { ...b, n: -b.n }).n; }
function multiply(a: Money, b: Money): Money { return { n: a.n * b.n, scale: a.scale + b.scale }; }
function display(a: Money): string {
  const divisor = 10n ** BigInt(Math.max(0, a.scale - 2));
  const abs = a.n < 0n ? -a.n : a.n;
  const cents = a.scale <= 2 ? abs * 10n ** BigInt(2 - a.scale) : (abs + divisor / 2n) / divisor;
  return `${a.n < 0n && cents !== 0n ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
function exact(a: Money): string {
  const digits = String(a.n).padStart(a.scale + 1, '0');
  return a.scale ? `${digits.slice(0, -a.scale)}.${digits.slice(-a.scale)}` : digits;
}
function quantity(value: string, unit: Unit): bigint {
  if (!['ml', 'g', 'unit'].includes(unit)) throw new Error('invalid_unit');
  const d = decimal(value);
  if (d.n <= 0n || d.scale > 6 || (unit === 'unit' && d.n % 10n ** BigInt(d.scale) !== 0n)) throw new Error('invalid_quantity');
  return d.n * 10n ** BigInt(6 - d.scale);
}
export function normalizeQuantity(value: string, unit: Unit | 'L' | 'kg'): { quantity: string; unit: Unit } {
  const d = decimal(value);
  const converted = unit === 'L' || unit === 'kg' ? multiply(d, { n: 1000n, scale: 0 }) : d;
  let n = converted.n, scale = converted.scale;
  while (scale > 0 && n % 10n === 0n) { n /= 10n; scale--; }
  const text = String(n).padStart(scale + 1, '0');
  const result = scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
  const canonical = unit === 'L' ? 'ml' : unit === 'kg' ? 'g' : unit;
  quantity(result, canonical);
  return { quantity: result, unit: canonical };
}
function count(value: string) {
  if (!/^[1-9]\d*$/.test(value) || value.length > 10 || BigInt(value) > MAX_COUNT) throw new Error('invalid_purchase_count');
  return BigInt(value);
}
export interface Need { id: string; quantity: string; unit: Unit; allowSurplus?: boolean }
export interface Offer {
  id: string; productId: string; currency: string; price: string | null;
  confirmed: boolean; available: boolean; pendingFailure: boolean; suspicious: boolean;
  priceCheckId: string | null; lastSuccessAt: string | null;
  coverage: { needId: string; quantity: string; unit: Unit }[];
  extras?: { id: string; quantity: string; unit: Unit; accepted: boolean }[];
  maxPurchaseUnits?: string;
}
export interface Alternative { id: string; scope: string[]; items: { offerId: string; purchaseUnits: string }[] }
export interface PurchaseInput {
  configurationVersion: string; currency: 'PEN' | 'USD'; evaluatedAt: string;
  needs: Need[]; offers: Offer[]; alternatives: Alternative[]; pins?: string[]; reference?: string[];
  fx?: { multiplier: string; from: 'PEN' | 'USD'; to: 'PEN' | 'USD'; date: string; source: string; fetchedAt: string };
  previousRecommendation?: { offerId: string; purchaseUnits: string }[];
  previousEffective?: { offerId: string; purchaseUnits: string }[];
}
export interface SearchOptions { maxNodes?: number; deadlineMs?: number; now?: () => number }
const zero: Money = { n: 0n, scale: 0 };
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function key(units: Map<string, bigint>) { return [...units].sort(([a], [b]) => order(a, b)).map(([id, n]) => `${id}:${n}`).join('|'); }
function limaDay(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_date');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function evaluatePurchases(input: PurchaseInput, options: SearchOptions = {}) {
  const maxNodes = options.maxNodes ?? 100000, deadlineMs = options.deadlineMs ?? 2000;
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 100000 || !Number.isFinite(deadlineMs) || deadlineMs < 0 || deadlineMs > 2000) throw new Error('invalid_search_limits');
  if (input.needs.length > 32 || input.offers.length > 64 || input.alternatives.length > 128) throw new Error('configuration_limit');
  if (!/^[1-9]\d*$/.test(input.configurationVersion)) throw new Error('invalid_version');
  if (!['PEN', 'USD'].includes(input.currency)) throw new Error('invalid_currency');
  const day = limaDay(input.evaluatedAt);
  function index<T extends { id: string }>(rows: T[]) {
    const map = new Map(rows.map(row => [row.id, row]));
    if (map.size !== rows.length || rows.some(row => !row.id)) throw new Error('duplicate_or_empty_id');
    return map;
  }
  const needs = index(input.needs), offers = index(input.offers), alternatives = index(input.alternatives);
  const required = new Map(input.needs.map(n => [n.id, quantity(n.quantity, n.unit)]));
  const costs = new Map<string, Money>(), invalidOffers = new Map<string, string>();
  for (const offer of offers.values()) {
    if ((offer.extras?.length ?? 0) > 32 || offer.coverage.length > 32) throw new Error('configuration_limit');
    if (offer.maxPurchaseUnits) count(offer.maxPurchaseUnits);
    const seen = new Set<string>();
    for (const coverage of offer.coverage) {
      if (seen.has(coverage.needId) || needs.get(coverage.needId)?.unit !== coverage.unit) throw new Error('invalid_coverage');
      seen.add(coverage.needId); quantity(coverage.quantity, coverage.unit);
    }
    for (const extra of offer.extras ?? []) quantity(extra.quantity, extra.unit);
    let reason = !['PEN', 'USD'].includes(offer.currency) ? 'unsupported_currency' : !offer.confirmed ? 'unconfirmed' : !offer.available ? 'unavailable' : offer.pendingFailure ? 'pending_failure' : offer.suspicious ? 'suspicious' : offer.price === null || !offer.priceCheckId || !offer.lastSuccessAt ? 'missing_price' : null;
    let price = offer.price === null ? zero : decimal(offer.price);
    if (offer.lastSuccessAt) {
      limaDay(offer.lastSuccessAt);
      if (Date.parse(offer.lastSuccessAt) > Date.parse(input.evaluatedAt)) reason = 'future_price';
    }
    if (!reason && offer.currency !== input.currency) {
      const fx = input.fx;
      if (!fx || fx.from !== offer.currency || fx.to !== input.currency) reason = 'missing_fx';
      else {
        const rate = decimal(fx.multiplier);
        const age = (Date.parse(day) - Date.parse(fx.date)) / 86400000;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fx.date) || !Number.isFinite(age) || age < 0 || age > 5 || rate.n <= 0n || !fx.source || new Date(fx.fetchedAt).getTime() > new Date(input.evaluatedAt).getTime() || !Number.isFinite(new Date(fx.fetchedAt).getTime())) reason = 'invalid_fx';
        else price = multiply(price, rate);
      }
    }
    if ((offer.extras ?? []).some(extra => !extra.accepted)) reason = 'unaccepted_extra';
    if (reason) invalidOffers.set(offer.id, reason); else costs.set(offer.id, price);
  }
  type Candidate = { id: string; scope: Set<string>; units: Map<string, bigint>; cost: Money; coverage: Map<string, bigint> };
  const candidates = new Map<string, Candidate>(), declared = new Map<string, Candidate>();
  const exclusions: { alternativeId: string; offerId?: string; reason: string }[] = [];
  for (const alt of alternatives.values()) {
    if (!alt.scope.length || !alt.items.length || alt.scope.length > 32 || alt.items.length > 32) throw new Error('invalid_alternative_size');
    const scope = new Set(alt.scope), units = new Map<string, bigint>(), coverage = new Map<string, bigint>();
    if (scope.size !== alt.scope.length || alt.scope.some(id => !needs.has(id))) throw new Error('invalid_scope');
    let cost = zero, invalid = false;
    for (const item of alt.items) {
      const offer = offers.get(item.offerId), amount = count(item.purchaseUnits);
      if (!offer || units.has(item.offerId)) throw new Error('invalid_items');
      units.set(offer.id, amount);
      const reason = invalidOffers.get(offer.id);
      if (reason) { exclusions.push({ alternativeId: alt.id, offerId: offer.id, reason }); invalid = true; }
      else cost = add(cost, multiply(costs.get(offer.id)!, { n: amount, scale: 0 }));
      for (const c of offer.coverage) {
        if (!scope.has(c.needId)) throw new Error('coverage_outside_scope');
        coverage.set(c.needId, (coverage.get(c.needId) ?? 0n) + quantity(c.quantity, c.unit) * amount);
      }
    }
    for (const id of scope) {
      const covered = coverage.get(id) ?? 0n, requested = required.get(id)!;
      if (covered < requested || (covered > requested && !needs.get(id)!.allowSurplus)) throw new Error('invalid_alternative_coverage');
    }
    const candidate = { id: alt.id, scope, units, cost, coverage };
    declared.set(alt.id, candidate);
    if (!invalid) candidates.set(alt.id, candidate);
  }
  function extend(selected: Candidate[], candidate: Candidate): Candidate[] | null {
    const next = [...selected, candidate], covered = new Set<string>(), units = new Map<string, bigint>();
    for (const c of next) {
      for (const id of c.scope) { if (covered.has(id)) return null; covered.add(id); }
      for (const [id, n] of c.units) {
        const sum = (units.get(id) ?? 0n) + n;
        if (sum > MAX_COUNT || (offers.get(id)!.maxPurchaseUnits && sum > count(offers.get(id)!.maxPurchaseUnits!))) return null;
        units.set(id, sum);
      }
    }
    return next;
  }
  function summarize(selected: Candidate[]) {
    const units = new Map<string, bigint>(), covered = new Map<string, bigint>(); let cost = zero;
    for (const c of selected) {
      cost = add(cost, c.cost);
      for (const [id, n] of c.units) units.set(id, (units.get(id) ?? 0n) + n);
      for (const [id, n] of c.coverage) covered.set(id, n);
    }
    return { units, covered, cost };
  }
  function search(pins: string[], previous: PurchaseInput['previousEffective'], direct = false) {
    if (new Set(pins).size !== pins.length || pins.some(id => !alternatives.has(id))) throw new Error('invalid_pin_or_reference');
    let initial: Candidate[] = [], pinned: Candidate[] = [], invalidPin = false;
    const reserved = new Set<string>();
    for (const id of pins) {
      const declaration = declared.get(id)!;
      const pinNext = extend(pinned, declaration);
      if (!pinNext) {
        if (!direct) throw new Error('incompatible_pins_or_reference');
        invalidPin = true; continue;
      }
      pinned = pinNext;
      const c = candidates.get(id);
      if (!c) { invalidPin = true; for (const need of declaration.scope) reserved.add(need); continue; }
      const next = extend(initial, c);
      if (!next) throw new Error('incompatible_pins_or_reference');
      initial = next;
    }
    let best: Candidate[] | null = null, partial = initial, nodes = 0, limitReason: string | null = null;
    const now = options.now ?? (() => performance.now()), start = now();
    const previousKey = previous ? key(new Map(previous.map(p => [p.offerId, count(p.purchaseUnits)]))) : null;
    function visit(selected: Candidate[]) {
      if (nodes >= maxNodes) { limitReason = 'node_limit'; return; }
      if (now() - start >= deadlineMs) { limitReason = 'deadline'; return; }
      nodes++;
      const state = summarize(selected), partialState = summarize(partial);
      if (state.covered.size > partialState.covered.size || (state.covered.size === partialState.covered.size && compare(state.cost, partialState.cost) < 0n)) partial = selected;
      if (state.covered.size === needs.size && needs.size > 0 && !invalidPin) {
        const incumbent = best && summarize(best), difference = incumbent ? compare(state.cost, incumbent.cost) : -1n;
        const candidateKey = key(state.units), incumbentKey = incumbent && key(incumbent.units);
        if (!incumbent || difference < 0n || (difference === 0n && (candidateKey === previousKey || (incumbentKey !== previousKey && order(candidateKey, incumbentKey!) < 0)))) best = selected;
        return;
      }
      if (direct || (best && compare(state.cost, summarize(best).cost) > 0n)) return;
      const choices = [...needs.keys()].filter(id => !state.covered.has(id)).map(id => ({ id, options: [...candidates.values()].filter(c => c.scope.has(id) && ![...c.scope].some(need => reserved.has(need)) && extend(selected, c)) }));
      // A dead need cannot recover deeper in this branch; still collect a feasible partial purchase.
      const viable = choices.filter(choice => choice.options.length > 0);
      viable.sort((a, b) => a.options.length - b.options.length || order(a.id, b.id));
      for (const c of viable[0]?.options.sort((a, b) => order(a.id, b.id)) ?? []) {
        visit([...selected, c]); if (limitReason) break;
      }
    }
    if (direct) {
      const s = summarize(initial);
      if (!invalidPin && s.covered.size === needs.size && needs.size) best = initial;
    } else visit(initial);
    const selected = best ?? partial, state = summarize(selected), complete = best !== null;
    return {
      alternativeIds: selected.map(c => c.id).sort(order), pinnedAlternativeIds: pins.slice().sort(order), invalidPin,
      purchases: [...state.units].sort(([a], [b]) => order(a, b)).map(([id, n]) => ({ offerId: id, purchaseUnits: String(n), offer: offers.get(id)!, convertedAmount: exact(multiply(costs.get(id)!, { n, scale: 0 })), extras: (offers.get(id)!.extras ?? []).map(extra => ({ ...extra, quantity: exact({ n: quantity(extra.quantity, extra.unit) * n, scale: 6 }) })) })),
      coverage: input.needs.map(n => ({ needId: n.id, unit: n.unit, required: exact({ n: required.get(n.id)!, scale: 6 }), covered: exact({ n: state.covered.get(n.id) ?? 0n, scale: 6 }), surplus: exact({ n: (state.covered.get(n.id) ?? 0n) > required.get(n.id)! ? state.covered.get(n.id)! - required.get(n.id)! : 0n, scale: 6 }) })),
      pendingNeedIds: input.needs.filter(n => !state.covered.has(n.id)).map(n => n.id),
      coverageComplete: complete, comparisonComplete: exclusions.length === 0, searchComplete: !limitReason,
      optimality: direct ? null : limitReason ? 'unproven' : !complete ? 'infeasible' : exclusions.length ? 'verified_subset' : 'verified_minimum',
      total: complete ? display(state.cost) : null, knownSubtotal: display(state.cost), visitedNodes: nodes, limitReason,
    };
  }
  const recommendation = search([], input.previousRecommendation), effective = search(input.pins ?? [], input.previousEffective);
  const reference = input.reference?.length ? search(input.reference, undefined, true) : null;
  // Savings use exact aggregate costs, with rounding only at the output boundary.
  function savings(selection: typeof effective) {
    if (!reference?.coverageComplete || !selection.coverageComplete) return { amount: null, percent: null };
    const value = (ids: string[]) => ids.reduce((sum, id) => add(sum, candidates.get(id)!.cost), zero);
    const base = value(reference.alternativeIds), selectedCost = value(selection.alternativeIds);
    const difference = add(base, { ...selectedCost, n: -selectedCost.n });
    if (base.n === 0n) return { amount: display(difference), percent: null };
    const numerator = difference.n * 10n ** BigInt(base.scale) * 10000n;
    const denominator = base.n * 10n ** BigInt(difference.scale);
    const abs = numerator < 0n ? -numerator : numerator;
    const rounded = (abs + denominator / 2n) / denominator;
    return { amount: display(difference), percent: display({ n: numerator < 0n ? -rounded : rounded, scale: 2 }) };
  }
  return { engineVersion: ENGINE_VERSION, configurationVersion: input.configurationVersion, input, recommendation, effective, reference, exclusions,
    recommendationSavings: savings(recommendation), effectiveSavings: savings(effective) };
}
