import { json, withSession } from '../../lib/server/auth.js';
import { uuidPattern } from '../../lib/product-contract.js';
import { isProductSummary, safeWebUrl, type ProductSummary } from '../../lib/home-contract.js';

const fields = 'id,list_id,url,domain,name,image_url,currency,reference_price,target_type,target_price,target_percent,last_price,status,last_checked_at,last_success_at,created_at';
const numericFields = ['reference_price', 'target_price', 'target_percent', 'last_price'] as const;

export function normalize(value: unknown): ProductSummary {
  if (!value || typeof value !== 'object') throw new Error('Invalid product');
  const raw = value as Record<string, unknown>;
  const row = Object.fromEntries(fields.split(',').map(key => [key, raw[key]]));
  for (const key of numericFields) {
    row[key] = typeof raw[key] === 'string' && /^\d+(\.\d+)?$/.test(raw[key]) ? Number(raw[key]) : raw[key];
  }
  row.image_url = safeWebUrl(raw.image_url);
  if (!Array.isArray(raw.price_checks)) throw new Error('Invalid history');
  row.history = raw.price_checks.filter(point => point.currency === raw.currency).map(point => ({
    checked_at: point.checked_at, price: typeof point.price === 'string' && /^\d+(\.\d+)?$/.test(point.price) ? Number(point.price) : point.price,
    currency: point.currency,
  })).sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
  if (!isProductSummary(row)) throw new Error('Invalid product summary');
  return row;
}

export default withSession(async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    json(res, 405, { error: 'Método no permitido.' });
    return;
  }
  const params = new URL(req.url ?? '', 'https://scrappy.local').searchParams;
  const listId = params.get('list_id');
  if (!listId || !uuidPattern.test(listId) || params.getAll('list_id').length !== 1
    || [...params.keys()].some(key => key !== 'list_id')) {
    json(res, 400, { error: 'Indica una lista válida.' });
    return;
  }
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key || new URL(base).protocol !== 'https:') throw new Error('Missing database configuration');
  const url = new URL('/rest/v1/products', base);
  url.search = new URLSearchParams({ select: `${fields},price_checks(checked_at,price,currency)`,
    list_id: `eq.${listId}`, order: 'created_at.desc,id.asc',
    'price_checks.ok': 'eq.true', 'price_checks.price': 'not.is.null',
    'price_checks.order': 'checked_at.desc,id.desc', 'price_checks.limit': '20',
  }).toString();
  const products: ProductSummary[] = [];
  // Read every page so PostgREST's row cap cannot silently hide products.
  for (let offset = 0; ;) {
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '1000');
    const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Product storage unavailable');
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid products response');
    const page = rows.map(normalize);
    if (page.some(row => row.list_id !== listId)) throw new Error('Unexpected product list');
    products.push(...page);
    const total = Number(response.headers.get('content-range')?.split('/')[1]);
    if (Number.isFinite(total) ? products.length >= total : rows.length < 1000) break;
    if (!rows.length) throw new Error('Incomplete products response');
    offset += rows.length;
  }
  json(res, 200, { products });
});
