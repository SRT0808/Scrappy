import { json, type Handler } from '../../lib/server/auth.js';
import { ProductError, productsHandler } from '../../lib/server/products.js';
import { uuidPattern, intervals, percentageTarget } from '../../lib/product-contract.js';
import { historicalStatistics, historyRanges, isReview, validProductEdit, type Review } from '../../lib/detail-contract.js';
import { normalize } from './index.js';

const fields = 'id,list_id,url,domain,name,image_url,currency,reference_price,target_type,target_price,target_percent,last_price,status,last_checked_at,last_success_at,created_at,check_interval_hours';
const checkFields = 'id,checked_at,ok,price,currency,method,error_code';

async function storage(table: string, params: Record<string, string>, method = 'GET', body?: unknown) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key || new URL(base).protocol !== 'https:') throw new Error('Missing database configuration');
  const url = new URL(`/rest/v1/${table}`, base);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, { method, headers: { apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json', Prefer: method === 'GET' ? 'count=exact' : 'return=representation' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    const error = await response.json();
    if (error?.code === '23503') throw new ProductError(404, 'La lista ya no existe.');
    throw new Error('Product storage unavailable');
  }
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error('Invalid product response');
  const range = response.headers.get('content-range')?.split('/')[1];
  return { rows, total: range && /^\d+$/.test(range) ? Number(range) : null };
}

export async function dispatchProduct(id: string) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Missing dispatch configuration');
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/check-prices.yml/dispatches`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', inputs: { mode: 'product', product_id: id } }), signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 204) throw new Error('Product dispatch unavailable');
}

export function createProductHandler(dispatch: (id: string) => Promise<void> = dispatchProduct): Handler {
  return productsHandler(['GET', 'PATCH', 'DELETE', 'POST'], async (req, res) => {
    const url = new URL(req.url ?? '', 'https://scrappy.local');
    const id = url.pathname.split('/').at(-1) ?? '';
    const range = url.searchParams.get('range') ?? '30';
    if (!uuidPattern.test(id) || !historyRanges.includes(range as typeof historyRanges[number])
      || url.searchParams.getAll('range').length > 1 || [...url.searchParams.keys()].some(k => k !== 'range')) {
      json(res, 400, { error: 'Indica un producto y rango válidos.' }); return;
    }
    if (req.method === 'PATCH') {
      const b = req.body;
      let update: Record<string, unknown>;
      if (b && typeof b === 'object' && Object.keys(b).join(',') === 'status'
        && ['active', 'paused'].includes(String((b as { status: string }).status))) {
        update = { status: (b as { status: string }).status };
      } else if (validProductEdit(b)) {
        update = { name: b.name.trim(), list_id: b.list_id, reference_price: b.reference_price, target_type: b.target_type,
          target_price: b.target_type === 'price' ? b.target_value : percentageTarget(b.reference_price, b.target_value),
          target_percent: b.target_type === 'percent' ? b.target_value : null, check_interval_hours: b.check_interval_hours };
      } else { json(res, 400, { error: 'Revisa el nombre, lista, referencia, meta e intervalo.' }); return; }
      // Preserve alert delivery state and scraper timestamps. Never activate unconfirmed products.
      const result = await storage('products', { id: `eq.${id}`, status: 'neq.pending_confirmation', select: 'id' }, 'PATCH', update);
      json(res, result.rows.length ? 200 : 404, result.rows.length ? { updated: true } : { error: 'El producto no existe o está sin confirmar.' }); return;
    }
    if (req.method === 'DELETE') {
      const result = await storage('products', { id: `eq.${id}`, select: 'id' }, 'DELETE');
      json(res, result.rows.length ? 200 : 404, result.rows.length ? { deleted: true } : { error: 'El producto ya no existe.' }); return;
    }
    const result = await storage('products', { id: `eq.${id}`, select: fields });
    if (!result.rows.length) { json(res, 404, { error: 'El producto ya no existe.' }); return; }
    const raw = result.rows[0] as Record<string, unknown>;
    const product = { ...normalize({ ...raw, price_checks: [] }), check_interval_hours: raw.check_interval_hours as number };
    if (product.id !== id || !intervals.includes(product.check_interval_hours)) throw new Error('Invalid product detail');
    if (req.method === 'POST') {
      if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).join(',') !== 'action'
        || (req.body as { action: string }).action !== 'review') { json(res, 400, { error: 'Acción no válida.' }); return; }
      if (!['active', 'error'].includes(product.status)) { json(res, 409, { error: 'Reanuda el producto antes de revisarlo.' }); return; }
      await dispatch(id);
      json(res, 202, { queued: true }); return;
    }
    const reviews: Review[] = [];
    // Fetch all pages for complete historical statistics, including a storage cap below 1000.
    for (let offset = 0; ;) {
      const page = await storage('price_checks', { product_id: `eq.${id}`, select: checkFields,
        order: 'checked_at.asc,id.asc', offset: String(offset), limit: '1000' });
      for (const row of page.rows) {
        if (!row || typeof row !== 'object') throw new Error('Invalid review');
        const rawCheck = row as Review;
        const check = { id: rawCheck.id, checked_at: rawCheck.checked_at, ok: rawCheck.ok,
          price: rawCheck.price === null ? null : Number(rawCheck.price), currency: rawCheck.currency,
          method: rawCheck.method, error_code: rawCheck.error_code };
        if (!isReview(check)) throw new Error('Invalid review');
        reviews.push(check);
      }
      offset += page.rows.length;
      if (page.total !== null ? offset >= page.total : page.rows.length < 1000) break;
      if (!page.rows.length) throw new Error('Incomplete history');
    }
    const history = reviews.filter(r => r.ok && r.price !== null && r.currency === product.currency)
      .map(r => ({ checked_at: r.checked_at, price: r.price!, currency: r.currency! }));
    product.history = history.slice(-20);
    const cutoff = range === 'all' ? -Infinity : Date.now() - Number(range) * 86400000;
    json(res, 200, { detail: { product, history: history.filter(p => Date.parse(p.checked_at) >= cutoff),
      statistics: historicalStatistics(history, product.reference_price), reviews: reviews.slice(-20).reverse() } });
  });
}

export default createProductHandler();
