import { purchaseErrorStatus } from './purchase-persistence.js';

export class PurchaseApiError extends Error {
  constructor(public status: number) { super('Purchase request failed'); }
}
export const validPurchaseVersion = (v: unknown): v is string => typeof v === 'string'
  && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;

// The SQL publisher owns graph/decimal validation and CAS in one transaction.
// A transport error is ambiguous: never retry a publication automatically.
export async function purchaseRpc(name: 'read_purchase_configuration' | 'save_purchase_configuration', body: unknown) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || new URL(url).protocol !== 'https:' || !key) throw new Error('Missing database configuration');
  const response = await fetch(new URL(`/rest/v1/rpc/${name}`, url), {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new PurchaseApiError(purchaseErrorStatus(result));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid purchase response');
  return result as Record<string, unknown>;
}

export const purchaseMessages: Record<number, string> = {
  400: 'Configuración de alternativas no válida.', 404: 'La canasta ya no existe.',
  409: 'La canasta cambió o aún no admite alternativas. Consulta su estado antes de volver a publicar.',
  503: 'Servicio temporalmente no disponible. Consulta el estado antes de volver a publicar.',
};
