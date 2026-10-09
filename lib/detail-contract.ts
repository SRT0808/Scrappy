import { isProductSummary, type PricePoint, type ProductSummary } from './home-contract.js';
import { intervals, money, uuidPattern } from './product-contract.js';

export const historyRanges = ['7', '30', '90', 'all'] as const;
export type HistoryRange = typeof historyRanges[number];
export type Review = { id: string; checked_at: string; ok: boolean; price: number | null; currency: string | null; method: string | null; error_code: string | null };
export type ProductEdit = { name: string; list_id: string; reference_price: string; target_type: 'price' | 'percent'; target_value: string; check_interval_hours: number };
export type Statistics = { count: number; min: number | null; max: number | null; average: number | null; discount_change: number | null };
export type ProductDetail = { product: ProductSummary & { check_interval_hours: number }; history: PricePoint[]; reviews: Review[]; statistics: Statistics };

export function validProductEdit(value: unknown): value is ProductEdit {
  if (!value || typeof value !== 'object') return false;
  const b = value as ProductEdit;
  return Object.keys(b).sort().join(',') === 'check_interval_hours,list_id,name,reference_price,target_type,target_value'
    && typeof b.name === 'string' && !!b.name.trim() && [...b.name.trim()].length <= 300
    && typeof b.list_id === 'string' && uuidPattern.test(b.list_id) && money(b.reference_price)
    && intervals.includes(b.check_interval_hours) && (b.target_type === 'price' ? money(b.target_value, true)
      : b.target_type === 'percent' && money(b.target_value) && Number(b.target_value) <= 100);
}

export function historicalStatistics(history: PricePoint[], reference: number | null): Statistics {
  if (!history.length) return { count: 0, min: null, max: null, average: null, discount_change: null };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const point of history) { min = Math.min(min, point.price); max = Math.max(max, point.price); sum += point.price; }
  return { count: history.length, min, max, average: sum / history.length,
    discount_change: history.length > 1 && reference !== null && reference > 0
      ? (history[0].price - history[history.length - 1].price) / reference * 100 : null };
}

export function isReview(value: unknown): value is Review {
  if (!value || typeof value !== 'object') return false;
  const r = value as Review;
  return typeof r.id === 'string' && uuidPattern.test(r.id) && typeof r.checked_at === 'string' && Number.isFinite(Date.parse(r.checked_at))
    && typeof r.ok === 'boolean' && (r.price === null || (typeof r.price === 'number' && Number.isFinite(r.price) && r.price >= 0 && r.price <= 9999999999.99))
    && (r.currency === null || (typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency)))
    && (r.method === null || typeof r.method === 'string') && (r.error_code === null || typeof r.error_code === 'string');
}

export function isProductDetail(value: unknown): value is ProductDetail {
  if (!value || typeof value !== 'object') return false;
  const d = value as ProductDetail;
  return isProductSummary(d.product) && intervals.includes(d.product.check_interval_hours)
    && Array.isArray(d.history) && d.history.every(p => p && typeof p.checked_at === 'string' && Number.isFinite(Date.parse(p.checked_at))
      && typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0 && p.price <= 9999999999.99 && p.currency === d.product.currency)
    && Array.isArray(d.reviews) && d.reviews.length <= 20 && d.reviews.every(isReview)
    && !!d.statistics && Number.isInteger(d.statistics.count) && d.statistics.count >= 0
    && [d.statistics.min, d.statistics.max, d.statistics.average, d.statistics.discount_change].every(n => n === null || (typeof n === 'number' && Number.isFinite(n)));
}
