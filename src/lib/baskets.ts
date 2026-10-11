export type Basket = {
  budget: number | null; currency: string; total: number | null;
  product_count: number; valid_count: number; complete: boolean;
  composition_version?: number; calculated_at?: string; reference_total?: number | null;
  current_total?: number | null; savings?: number | null; savings_percent?: number | null;
  stale_count?: number; unavailable_count?: number; missing_count?: number; fx_missing_count?: number;
  lines?: BasketLine[]; exchange_rates?: Conversion[];
};
export type Conversion = { from: string; to: string; rate: number; date: string; source: string };
export type BasketLine = { product_id: string; quantity: number; currency: string | null; reference_price: number | null;
  last_price: number | null; last_success_at: string | null; last_checked_at: string | null;
  stale: boolean; unavailable: boolean; valid: boolean; conversion: Conversion | null };
export type Snapshot = { id: string; composition_version: number; calculated_at: string; currency: string;
  reference_total: number | null; current_total: number | null; savings: number | null; savings_percent: number | null; complete: boolean };
export type BasketDetail = { id: string; name: string; basket: Basket; versions: number[]; snapshots: Snapshot[] };
const amount = (n: unknown) => n === null || typeof n === 'number' && Number.isFinite(n);
const date = (n: unknown) => typeof n === 'string' && Number.isFinite(Date.parse(n));
const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
const conversion = (c: Conversion) => c && /^[A-Z]{3}$/.test(c.from) && /^[A-Z]{3}$/.test(c.to)
  && Number.isFinite(c.rate) && c.rate > 0 && date(c.date) && typeof c.source === 'string';

export function isBasket(value: unknown): value is Basket {
  if (!value || typeof value !== 'object') return false;
  const b = value as Basket;
  return (b.budget === null || Number.isFinite(b.budget) && b.budget > 0 && b.budget <= 9999999999.99)
    && typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency)
    && (b.total === null || Number.isFinite(b.total) && b.total >= 0)
    && Number.isInteger(b.product_count) && b.product_count >= 0
    && Number.isInteger(b.valid_count) && b.valid_count >= 0 && b.valid_count <= b.product_count
    && b.complete === (b.product_count > 0 && b.valid_count === b.product_count)
    && (b.composition_version === undefined || count(b.composition_version) && b.composition_version > 0)
    && (b.lines === undefined || Array.isArray(b.lines) && b.lines.length === b.product_count && b.lines.every(l => l
      && typeof l.product_id === 'string' && count(l.quantity) && l.quantity > 0
      && [l.reference_price,l.last_price].every(amount) && (l.last_success_at === null || date(l.last_success_at))
      && (l.last_checked_at === null || date(l.last_checked_at)) && [l.stale,l.unavailable,l.valid].every(x => typeof x === 'boolean')
      && (l.conversion === null || conversion(l.conversion))))
    && (b.exchange_rates === undefined || Array.isArray(b.exchange_rates) && b.exchange_rates.every(conversion));
}

export function isBasketDetail(value: unknown): value is BasketDetail {
  const d = value as BasketDetail;
  return !!d && typeof d.id === 'string' && typeof d.name === 'string' && isBasket(d.basket)
    && count(d.basket.composition_version) && Array.isArray(d.basket.lines)
    && Array.isArray(d.versions) && d.versions.every(v => count(v) && v > 0)
    && Array.isArray(d.snapshots) && d.snapshots.every(s => s && typeof s.id === 'string'
      && d.versions.includes(s.composition_version) && date(s.calculated_at) && /^[A-Z]{3}$/.test(s.currency)
      && typeof s.complete === 'boolean' && [s.reference_total,s.current_total,s.savings,s.savings_percent].every(amount)
      && (!s.complete || s.current_total !== null));
}

export function basketStatistics(points: Snapshot[], version: number) {
  const complete = points.filter(s => s.composition_version === version && s.complete && s.current_total !== null)
    .sort((a,b) => Date.parse(a.calculated_at)-Date.parse(b.calculated_at));
  const days = complete.length > 1 ? (Date.parse(complete.at(-1)!.calculated_at)-Date.parse(complete[0].calculated_at))/86400000 : 0;
  if (complete.length < 10 || days < 14) return { count: complete.length, days, eligible: false as const };
  const sorted = [...complete].sort((a,b) => a.current_total!-b.current_total!);
  const middle = Math.floor(sorted.length/2);
  return { count: complete.length, days, eligible: true as const, min: sorted[0], max: sorted.at(-1)!,
    average: complete.reduce((sum,s) => sum+s.current_total!,0)/complete.length,
    median: sorted.length%2 ? sorted[middle].current_total! : (sorted[middle-1].current_total!+sorted[middle].current_total!)/2,
    first: complete[0].calculated_at, last: complete.at(-1)!.calculated_at };
}

export async function requestBasket(id: string, range = '30', body?: { product_id: string; quantity: number | null; version: number }, signal?: AbortSignal): Promise<BasketDetail> {
  const response = await fetch(`/api/baskets/${encodeURIComponent(id)}?range=${range}`, { method: body ? 'PATCH' : 'GET',
    credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw { status: response.status, message: response.status === 401 ? 'Tu sesión ha caducado.'
    : response.status === 409 ? 'La composición cambió. Actualiza antes de guardar.' : 'No pudimos consultar o guardar la canasta. Actualiza antes de reintentar.' };
  const payload = await response.json();
  if (!isBasketDetail(payload.detail) || payload.detail.id !== id) throw new Error('La respuesta de la canasta no es válida.');
  return payload.detail;
}

export function parseBudget(value: string): number | null {
  if (!/^\d{1,10}([.,]\d{1,2})?$/.test(value.trim())) return null;
  const number = Number(value.trim().replace(',', '.'));
  return number > 0 && number <= 9999999999.99 ? number : null;
}
