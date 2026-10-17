import { createHash } from 'node:crypto';
import { ENGINE_VERSION, evaluatePurchases, type PurchaseInput, type SearchOptions } from './purchase-engine.js';

/** Local archive only. No database, live capture, alert writer or engine activation. */
export const SNAPSHOT_VERSION = 1;
export type PurchaseSnapshot = ReturnType<typeof capturePurchaseSnapshot>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('non_json_snapshot');
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function keys(value: unknown, allowed: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.split(' ').includes(key))) throw new Error('invalid_snapshot_fields');
}
function validateInput(input: PurchaseInput) {
  keys(input, 'configurationVersion currency evaluatedAt needs offers alternatives pins reference fx previousRecommendation previousEffective');
  const text = (value: unknown) => { if (typeof value !== 'string' || !value.length) throw new Error('invalid_snapshot_value'); };
  const flag = (value: unknown) => { if (typeof value !== 'boolean') throw new Error('invalid_snapshot_value'); };
  const rows = (value: unknown) => { if (!Array.isArray(value)) throw new Error('invalid_snapshot_value'); };
  text(input.configurationVersion); text(input.currency); text(input.evaluatedAt);
  rows(input.needs); rows(input.offers); rows(input.alternatives);
  for (const need of input.needs) keys(need, 'id quantity unit allowSurplus');
  for (const need of input.needs) {
    text(need.id); text(need.quantity); text(need.unit);
    if (need.allowSurplus !== undefined) flag(need.allowSurplus);
  }
  for (const offer of input.offers) {
    keys(offer, 'id productId currency price confirmed available pendingFailure suspicious priceCheckId lastSuccessAt coverage extras maxPurchaseUnits');
    text(offer.id); text(offer.productId); text(offer.currency);
    for (const value of [offer.price, offer.priceCheckId, offer.lastSuccessAt]) if (value !== null) text(value);
    for (const value of [offer.confirmed, offer.available, offer.pendingFailure, offer.suspicious]) flag(value);
    if (offer.maxPurchaseUnits !== undefined) text(offer.maxPurchaseUnits);
    rows(offer.coverage); if (offer.extras !== undefined) rows(offer.extras);
    for (const row of offer.coverage) { keys(row, 'needId quantity unit'); text(row.needId); text(row.quantity); text(row.unit); }
    for (const row of offer.extras ?? []) { keys(row, 'id quantity unit accepted'); text(row.id); text(row.quantity); text(row.unit); flag(row.accepted); }
  }
  for (const alternative of input.alternatives) {
    keys(alternative, 'id scope items');
    text(alternative.id); rows(alternative.scope); rows(alternative.items); alternative.scope.forEach(text);
    for (const row of alternative.items) { keys(row, 'offerId purchaseUnits'); text(row.offerId); text(row.purchaseUnits); }
  }
  for (const ids of [input.pins, input.reference]) if (ids !== undefined) { rows(ids); ids.forEach(text); }
  if (input.fx !== undefined) { keys(input.fx, 'multiplier from to date source fetchedAt'); for (const key of ['multiplier', 'from', 'to', 'date', 'source', 'fetchedAt'] as const) text(input.fx[key]); }
  for (const previous of [input.previousRecommendation, input.previousEffective]) if (previous !== undefined) {
    rows(previous);
    for (const row of previous) { keys(row, 'offerId purchaseUnits'); text(row.offerId); text(row.purchaseUnits); }
  }
}
function normalize(input: PurchaseInput): PurchaseInput {
  validateInput(input);
  const copy: PurchaseInput = JSON.parse(canonicalJson(input));
  const sort = <T>(rows: T[], id: (row: T) => string) => rows.sort((a, b) => id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
  sort(copy.needs, row => row.id); sort(copy.offers, row => row.id); sort(copy.alternatives, row => row.id);
  for (const offer of copy.offers) { sort(offer.coverage, row => row.needId); if (offer.extras) sort(offer.extras, row => row.id); }
  for (const alternative of copy.alternatives) { alternative.scope.sort(); sort(alternative.items, row => row.offerId); }
  copy.pins?.sort(); copy.reference?.sort();
  if (copy.previousRecommendation) sort(copy.previousRecommendation, row => row.offerId);
  if (copy.previousEffective) sort(copy.previousEffective, row => row.offerId);
  return copy;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function signature(listId: string, input: PurchaseInput, limits: { maxNodes: number; deadlineMs: number }) {
  const validityDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(input.evaluatedAt));
  const { evaluatedAt: _timestamp, ...state } = input;
  return hash({ listId, state, validityDate, limits, engineVersion: ENGINE_VERSION });
}

export function capturePurchaseSnapshot(listId: string, input: PurchaseInput, options: SearchOptions = {}) {
  if (typeof listId !== 'string' || !listId.trim()) throw new Error('invalid_list_id');
  const inputs = normalize(input);
  const limits = { maxNodes: options.maxNodes ?? 100000, deadlineMs: options.deadlineMs ?? 2000 };
  // Record clock samples, including each search start, so deadline cuts replay exactly.
  const clock: number[] = [], now = options.now ?? (() => performance.now());
  const result = evaluatePurchases(inputs, { ...limits, now: () => {
    const value = now();
    if (!Number.isFinite(value) || (clock.length && value < clock[clock.length - 1])) throw new Error('invalid_snapshot_clock');
    clock.push(value); return value;
  } });
  const body = {
    schema_version: 2 as const, snapshot_version: SNAPSHOT_VERSION, list_id: listId,
    configuration_version: inputs.configurationVersion, engine_version: ENGINE_VERSION,
    input_signature: signature(listId, inputs, limits), evaluated_at: inputs.evaluatedAt,
    currency: inputs.currency, inputs, limits, clock, result,
  };
  return freeze({ ...body, checksum: hash(body) });
}

export function replayPurchaseSnapshot(value: unknown) {
  keys(value, 'schema_version snapshot_version list_id configuration_version engine_version input_signature evaluated_at currency inputs limits clock result checksum');
  const snapshot = value as PurchaseSnapshot;
  if (snapshot.schema_version !== 2 || snapshot.snapshot_version !== SNAPSHOT_VERSION || snapshot.engine_version !== ENGINE_VERSION) throw new Error('unsupported_snapshot_version');
  const { checksum, ...body } = snapshot;
  if (checksum !== hash(body)) throw new Error('snapshot_checksum_mismatch');
  keys(snapshot.limits, 'maxNodes deadlineMs');
  if (!Array.isArray(snapshot.clock) || snapshot.clock.length > 200005) throw new Error('invalid_snapshot_clock');
  let cursor = 0;
  const reproduced = capturePurchaseSnapshot(snapshot.list_id, snapshot.inputs, { ...snapshot.limits, now: () => {
    if (cursor >= snapshot.clock.length) throw new Error('snapshot_clock_exhausted');
    return snapshot.clock[cursor++];
  } });
  if (cursor !== snapshot.clock.length || canonicalJson(reproduced) !== canonicalJson(snapshot)) throw new Error('snapshot_replay_mismatch');
  return reproduced;
}
