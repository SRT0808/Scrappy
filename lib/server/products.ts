import { json, withSession, type Handler } from './auth.js';

export class ProductError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function productDatabase(path: string, body?: unknown): Promise<unknown> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || new URL(url).protocol !== 'https:') throw new Error('Missing database configuration');
  const response = await fetch(new URL(`/rest/v1/${path}`, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const error = await response.json();
    const messages: Record<string, [number, string]> = {
      PT400: [400, 'Revisa los datos del producto.'], PT404: [404, 'La lectura o lista ya no existe.'],
      PT409: [409, 'La lectura cambió o todavía no está lista. Consulta su estado.'],
      '23503': [404, 'La lista ya no existe.'],
    };
    if (messages[error?.code]) throw new ProductError(...messages[error.code]);
    throw new Error('Product storage unavailable');
  }
  return response.json();
}

export async function dispatchReading(id: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Missing dispatch configuration');
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/check-prices.yml/dispatches`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', inputs: { mode: 'reading', reading_id: id } }), signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 204) throw new Error('Reading dispatch unavailable');
}

export function productsHandler(methods: string[], handler: Handler): Handler {
  return withSession(async (req, res) => {
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', ')); json(res, 405, { error: 'Método no permitido.' }); return;
    }
    if (['POST', 'PATCH'].includes(req.method ?? '') && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      json(res, 415, { error: 'Envía los datos en formato JSON.' }); return;
    }
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof ProductError) json(res, error.status, { error: error.message });
      else throw error;
    }
  });
}
