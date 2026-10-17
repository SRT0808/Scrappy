import type { ApiRequest, Handler } from './auth.js';
import { json, withSession } from './auth.js';
import { isBasket } from '../../src/lib/baskets.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type List = { id: string; name: string; emoji: string | null; position: number; created_at: string };

export function objectBody(req: ApiRequest): Record<string, unknown> | null {
  return req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : null;
}

export function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= 100;
}

export function validEmoji(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === 'string' && [...value].length <= 16);
}

class ListError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function listDatabase(operation: string, body?: unknown): Promise<unknown> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || new URL(url).protocol !== 'https:') throw new Error('Missing database configuration');
  const response = await fetch(new URL(operation === 'read'
    ? '/rest/v1/rpc/read_lists_with_baskets'
    : operation === 'basket' ? '/rest/v1/rpc/configure_list_basket'
    : '/rest/v1/rpc/mutate_list', url), {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const error: unknown = await response.json();
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'PT400') throw new ListError(400, 'Datos de lista no válidos.');
    if (code === 'PT404') throw new ListError(404, 'La lista ya no existe.');
    if (['PT409','40001','40P01'].includes(String(code))) throw new ListError(409, 'Las listas cambiaron. Actualiza e inténtalo de nuevo.');
    if (code === '23503') throw new ListError(409, 'La lista contiene productos. Muévelos o elimínalos primero.');
    throw new Error('List storage unavailable');
  }
  const result: unknown = await response.json();
  if (operation === 'delete' && result === null) return result;
  if (['create', 'rename', 'basket'].includes(operation) && Array.isArray(result)) throw new Error('Invalid list response');
  const rows = Array.isArray(result) ? result : [result];
  if ((operation === 'read' || operation === 'reorder') && !Array.isArray(result)) throw new Error('Invalid lists response');
  if (!rows.every(row => row && typeof row === 'object' && typeof row.id === 'string' && UUID.test(row.id)
    && validName(row.name) && (row.emoji === null || typeof row.emoji === 'string')
    && Number.isInteger(row.position) && typeof row.created_at === 'string'
    && (row.basket === undefined || row.basket === null || isBasket(row.basket)))) throw new Error('Invalid list response');
  if (operation !== 'read' && rows.some(row => row.budget !== undefined || row.basket_budget != null)) {
    const current = await listDatabase('read') as Array<{ id: string }>;
    const enriched = rows.map(row => current.find(list => list.id === row.id));
    if (enriched.some(row => !row)) throw new Error('List changed during mutation');
    return Array.isArray(result) ? enriched : enriched[0];
  }
  return result;
}

export function listsHandler(methods: string[], handler: Handler): Handler {
  return withSession(async (req, res) => {
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', '));
      json(res, 405, { error: 'Método no permitido.' });
      return;
    }
    if (['POST', 'PATCH', 'PUT'].includes(req.method!)
      && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      json(res, 415, { error: 'Envía los datos en formato JSON.' });
      return;
    }
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof ListError) json(res, error.status, { error: error.message });
      else throw error;
    }
  });
}
