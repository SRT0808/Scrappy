import { createHash } from 'node:crypto';
import { ENGINE_VERSION, type PurchaseInput } from './purchase-engine.js';
import { canonicalJson, capturePurchaseSnapshot, replayPurchaseSnapshot, type PurchaseSnapshot } from './purchase-snapshots.js';

// Server-only protocol. The connection must be exclusive for the whole transaction.
export interface PurchaseConnection {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface PurchaseCapture {
  token_version: 1; list_id: string; configuration_version: string;
  input_revision: string; state_revision: string; mode: 'alternatives';
  evaluated_at: string; validity_date: string; source_fingerprint: string;
  engine_version: typeof ENGINE_VERSION; limits: { maxNodes: number; deadlineMs: number };
  previous_recommendation: PurchaseInput['previousRecommendation'];
  previous_effective: PurchaseInput['previousEffective']; capture_signature: string;
}
export const purchaseHash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function purchaseDay(at: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
function exactKeys(value: unknown, names: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(' ') !== names.split(' ').sort().join(' ')) throw new Error('invalid_purchase_fields');
}
export function validatePurchaseCapture(value: unknown): PurchaseCapture {
  exactKeys(value, 'token_version list_id configuration_version input_revision state_revision mode evaluated_at validity_date source_fingerprint engine_version limits previous_recommendation previous_effective capture_signature');
  const c = value as PurchaseCapture;
  exactKeys(c.limits, 'maxNodes deadlineMs');
  if (c.token_version !== 1 || c.engine_version !== ENGINE_VERSION || c.mode !== 'alternatives' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.list_id) ||
      [c.list_id, c.configuration_version, c.input_revision, c.state_revision, c.validity_date].some(v => typeof v !== 'string') ||
      !/^[1-9]\d*$/.test(c.configuration_version) || !/^(0|[1-9]\d*)$/.test(c.input_revision) || !/^(0|[1-9]\d*)$/.test(c.state_revision) ||
      [c.configuration_version, c.input_revision, c.state_revision].some(v => v.length > 19 || BigInt(v) > 9223372036854775807n) ||
      c.limits.maxNodes !== 100000 || c.limits.deadlineMs !== 2000 ||
      typeof c.evaluated_at !== 'string' || !Number.isFinite(Date.parse(c.evaluated_at)) || purchaseDay(c.evaluated_at) !== c.validity_date ||
      typeof c.source_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(c.source_fingerprint) ||
      !Array.isArray(c.previous_recommendation) || !Array.isArray(c.previous_effective)) throw new Error('invalid_purchase_capture');
  for (const vector of [c.previous_recommendation!, c.previous_effective!]) for (const row of vector) {
    exactKeys(row, 'offerId purchaseUnits');
    if (typeof row.offerId !== 'string' || typeof row.purchaseUnits !== 'string' || !/^[1-9]\d*$/.test(row.purchaseUnits)) throw new Error('invalid_purchase_tie');
  }
  const { capture_signature, ...body } = c;
  if (capture_signature !== purchaseHash(body)) throw new Error('capture_signature_mismatch');
  return JSON.parse(canonicalJson(c)) as PurchaseCapture;
}
export function validatePurchaseCommit(listId: string, version: string, signature: string, value: unknown) {
  exactKeys(value, 'capture snapshot');
  const payload = value as { capture: PurchaseCapture; snapshot: PurchaseSnapshot };
  const c = validatePurchaseCapture(payload.capture), s = replayPurchaseSnapshot(payload.snapshot);
  if (c.list_id !== listId || c.configuration_version !== version || c.capture_signature !== signature ||
      s.list_id !== listId || s.configuration_version !== version || s.evaluated_at !== c.evaluated_at ||
      canonicalJson(s.limits) !== canonicalJson(c.limits) ||
      canonicalJson(s.inputs.previousRecommendation ?? []) !== canonicalJson(c.previous_recommendation) ||
      canonicalJson(s.inputs.previousEffective ?? []) !== canonicalJson(c.previous_effective)) throw new Error('purchase_capture_mismatch');
  return { capture: c, snapshot: s, persistence_signature: purchaseHash({ capture_signature: signature, input_signature: s.input_signature, engine_version: s.engine_version }) };
}
export function purchaseErrorStatus(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (['40001', '40P01', 'PT409'].includes(code ?? '')) return 409;
  if (code === 'PT404') return 404;
  if (code === 'PT400') return 400;
  return 503;
}
async function transaction<T>(db: PurchaseConnection, work: () => Promise<T>): Promise<T> {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try { const result = await work(); await db.query('COMMIT'); return result; }
  catch (error) {
    // A disconnected session already rolled back; preserve the original SQLSTATE.
    try { await db.query('ROLLBACK'); } catch { /* connection may be lost */ }
    throw error;
  }
}
export async function capturePurchaseInputs(db: PurchaseConnection, listId: string, version: string) {
  const row = await transaction(db, async () => (await db.query('SELECT public.capture_purchase_inputs($1::uuid,$2::bigint) AS value', [listId, version])).rows[0].value);
  const { capture, inputs } = row as { capture: PurchaseCapture; inputs: PurchaseInput };
  return { capture: validatePurchaseCapture(capture), inputs };
}
// Local worker only. Recheck under the gate so concurrent/stale discovery cannot
// create another evaluation after another worker has already cleared the work.
export async function capturePendingPurchaseInputs(db: PurchaseConnection, listId: string) {
  const row = await transaction(db, async () => {
    await db.query('SELECT public.enter_purchase_operation()');
    return (await db.query(`SELECT public.capture_purchase_inputs(l.id,l.composition_version) AS value
      FROM public.lists l WHERE l.id=$1::uuid AND l.purchase_mode='alternatives'
      AND public.read_current_purchase_evaluation(l.id)->>'evaluation_id' IS NULL`, [listId])).rows[0]?.value;
  });
  if (!row) return null;
  const { capture, inputs } = row as { capture: PurchaseCapture; inputs: PurchaseInput };
  return { capture: validatePurchaseCapture(capture), inputs };
}
export function evaluatePurchaseCapture(captured: { capture: PurchaseCapture; inputs: PurchaseInput }) {
  const capture = validatePurchaseCapture(captured.capture);
  const snapshot = capturePurchaseSnapshot(capture.list_id, captured.inputs, capture.limits);
  validatePurchaseCommit(capture.list_id, capture.configuration_version, capture.capture_signature, { capture, snapshot });
  return { capture, snapshot };
}
export async function commitPurchaseEvaluation(db: PurchaseConnection, listId: string, version: string, signature: string, payload: unknown) {
  const valid = validatePurchaseCommit(listId, version, signature, payload);
  return transaction(db, async () => (await db.query(
    'SELECT public.commit_purchase_evaluation($1::uuid,$2::bigint,$3::text,$4::jsonb) AS value',
    [listId, version, signature, canonicalJson({ capture: valid.capture, snapshot: valid.snapshot })],
  )).rows[0].value);
}
// Staged only: SQL validates the entire graph and requires already-enabled alternatives mode.
// No automatic retry after a lost response or a serialization/CAS conflict.
export async function savePurchaseConfiguration(db: PurchaseConnection, listId: string, expectedVersion: string, configuration: unknown) {
  return transaction(db, async () => (await db.query(
    'SELECT public.save_purchase_configuration($1::uuid,$2::bigint,$3::jsonb) AS value',
    [listId, expectedVersion, canonicalJson(configuration)],
  )).rows[0].value);
}
// Future source writers enter here BEFORE any source read/lock. No operational caller yet.
export async function mutatePurchaseSources<T>(db: PurchaseConnection, work: () => Promise<T>, products: string[], fx = false, configurations: string[] = []) {
  return transaction(db, async () => {
    await db.query('SELECT public.enter_purchase_operation()');
    const result = await work();
    await db.query('SELECT public.invalidate_purchase_inputs($1::uuid[],$2::boolean,$3::uuid[])', [products, fx, configurations]);
    return result;
  });
}
