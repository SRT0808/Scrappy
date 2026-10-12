import type { ApiRequest } from './auth.js';
import { uuidPattern } from '../product-contract.js';

export function readDynamicRoute(req: ApiRequest, collection: 'products' | 'baskets' | 'lists', allowedQuery: string[] = []) {
  try {
    const url = new URL(req.url ?? '', 'https://scrappy.local');
    const pathname = decodeURIComponent(url.pathname).replace(/\/$/, '');
    const prefix = `/api/${collection}/`;
    if (!pathname.startsWith(prefix)) return null;
    const pathId = pathname.slice(prefix.length);
    const params = url.searchParams;
    for (const key of params.keys()) {
      if (key !== 'id' && !allowedQuery.includes(key) || params.getAll(key).length !== 1) return null;
    }
    // Vercel rewrites /api/<collection>/<uuid> to /api/<collection>/[id]?id=<uuid>
    // (or [id].ts), and derives req.query from that same URL. Local Vite keeps the public path.
    const id = params.get('id') ?? pathId;
    if (!uuidPattern.test(id) || (pathId !== '[id]' && pathId !== '[id].ts'
      && pathId.toLowerCase() !== id.toLowerCase())) return null;
    return { id, params };
  } catch {
    return null;
  }
}
