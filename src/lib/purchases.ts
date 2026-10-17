import type { evaluatePurchases } from '../../lib/server/purchase-engine';

export type Unit = 'ml' | 'g' | 'unit';
export type Configuration = {
  schema_version: 2; version?: string; currency: 'PEN' | 'USD'; budget: string | null;
  budget_enabled: boolean; winner_enabled: boolean; minimum_savings: string;
  needs: { id: string; name: string; required_quantity: string; unit: Unit; position: number; allow_surplus: boolean }[];
  offers: { id: string; product_id: string; max_purchase_units: number | null;
    coverage: { need_id: string; quantity: string }[];
    extras: { id: string; name: string; quantity: string; unit: Unit; accepted: boolean }[] }[];
  alternatives: { id: string; name: string; position: number; scope: string[]; items: { offer_id: string; purchase_units: number }[] }[];
  pins: string[]; reference: string[];
};
export type PurchaseResult = ReturnType<typeof evaluatePurchases>;
export type PurchaseRead = {
  schema_version: 2; list_id: string; mode: 'legacy' | 'alternatives'; version: string;
  configuration: Configuration | null; stale_reason: string | null;
  latest_evaluation: null | { evaluation_id: string; snapshot: { configuration_version: string; evaluated_at: string; currency: string; result: PurchaseResult } };
  events: { id: string; version: string; reasons: 'budget' | 'winner' | 'both'; status: string;
    deliveries: { channel: string; status: string; receipt: unknown }[] }[]; has_more: boolean;
};
export class PurchaseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
// Explicit projection: canonical reads contain historical metadata rejected by the publisher.
export function publication(c: Configuration): Configuration {
  return { schema_version: 2, currency: c.currency, budget: c.budget, budget_enabled: c.budget_enabled,
    winner_enabled: c.winner_enabled, minimum_savings: c.minimum_savings,
    needs: c.needs.map(({ id, name, required_quantity, unit, position, allow_surplus }) => ({ id, name, required_quantity, unit, position, allow_surplus })),
    offers: c.offers.map(({ id, product_id, max_purchase_units, coverage, extras }) => ({ id, product_id, max_purchase_units,
      coverage: coverage.map(({ need_id, quantity }) => ({ need_id, quantity })),
      extras: extras.map(({ id, name, quantity, unit, accepted }) => ({ id, name, quantity, unit, accepted })) })),
    alternatives: c.alternatives.map(({ id, name, position, scope, items }) => ({ id, name, position, scope: [...scope], items: items.map(({ offer_id, purchase_units }) => ({ offer_id, purchase_units })) })),
    pins: [...c.pins], reference: [...c.reference] };
}
async function request(id: string, page: number, body?: unknown, signal?: AbortSignal) {
  if (body && !navigator.onLine) throw new PurchaseError(0, 'Sin conexión. Consulta el estado antes de guardar.');
  let response: Response;
  try {
    response = await fetch(`/api/baskets/${encodeURIComponent(id)}/purchases${body ? '' : `?page=${page}`}`, {
      method: body ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
  } catch { throw new PurchaseError(0, 'No pudimos confirmar el resultado. Consulta el estado antes de guardar otra vez.'); }
  if (!response.ok) throw new PurchaseError(response.status, ({
    400: 'Revisa cantidades, coberturas, límites y fijaciones: la configuración no es válida.',
    401: 'Tu sesión ha caducado.', 409: 'La canasta cambió. Consulta el estado y revisa tu borrador antes de guardar.',
  } as Record<number, string>)[response.status] ?? 'No pudimos confirmar el resultado. Consulta el estado antes de guardar otra vez.');
  try { return await response.json(); }
  catch { throw new PurchaseError(0, 'Respuesta no válida. Consulta el estado antes de guardar otra vez.'); }
}
export async function readPurchases(id: string, page = 0, signal?: AbortSignal): Promise<PurchaseRead> {
  const r = await request(id, page, undefined, signal);
  try {
    if (r.schema_version !== 2 || r.list_id !== id || !/^[1-9]\d{0,18}$/.test(r.version)
      || !['legacy', 'alternatives'].includes(r.mode) || !Array.isArray(r.events) || typeof r.has_more !== 'boolean'
      || !Object.hasOwn(r, 'stale_reason') || !Object.hasOwn(r, 'latest_evaluation')) throw new Error();
    if (r.mode === 'alternatives') publication(r.configuration);
    if (r.latest_evaluation && (r.stale_reason !== null || r.latest_evaluation.snapshot.configuration_version !== r.version
      || r.latest_evaluation.snapshot.result.configurationVersion !== r.version)) throw new Error();
    return r;
  } catch { throw new PurchaseError(0, 'Respuesta de alternativas no válida. Consulta el estado de nuevo.'); }
}
export async function savePurchases(id: string, version: string, configuration: Configuration) {
  const r = await request(id, 0, { schema_version: 2, expected_version: version, configuration: publication(configuration) });
  if (r.schema_version !== 2 || r.configuration?.version !== (BigInt(version) + 1n).toString())
    throw new PurchaseError(0, 'Publicación sin confirmar. Consulta el estado antes de guardar otra vez.');
}
