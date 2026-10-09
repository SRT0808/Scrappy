import { uuidPattern } from './product-contract.js';

export type PricePoint = { checked_at: string; price: number; currency: string };
export type ProductSummary = {
  id: string; list_id: string; url: string; domain: string; name: string | null; image_url: string | null;
  currency: string | null; reference_price: number | null; target_type: 'price' | 'percent' | null;
  target_price: number | null; target_percent: number | null; last_price: number | null;
  status: 'pending_confirmation' | 'active' | 'paused' | 'error';
  last_checked_at: string | null; last_success_at: string | null; created_at: string; history: PricePoint[];
};

export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const amount = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9999999999.99);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const currency = (value: unknown) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

export function isProductSummary(value: unknown): value is ProductSummary {
  if (!value || typeof value !== 'object') return false;
  const row = value as ProductSummary;
  return typeof row.id === 'string' && uuidPattern.test(row.id) && typeof row.list_id === 'string' && uuidPattern.test(row.list_id)
    && !!safeWebUrl(row.url) && typeof row.domain === 'string' && row.domain.length > 0
    && (row.name === null || typeof row.name === 'string') && (row.image_url === null || !!safeWebUrl(row.image_url))
    && (row.currency === null || currency(row.currency))
    && [row.reference_price, row.target_price, row.last_price].every(amount)
    && (row.target_type === null || ['price', 'percent'].includes(row.target_type))
    && (row.target_percent === null || (typeof row.target_percent === 'number' && row.target_percent > 0 && row.target_percent <= 100))
    && ['pending_confirmation', 'active', 'paused', 'error'].includes(row.status)
    && nullableDate(row.last_checked_at) && nullableDate(row.last_success_at) && date(row.created_at)
    && Array.isArray(row.history) && row.history.length <= 20 && row.history.every(point => point && date(point.checked_at)
      && point.price !== null && amount(point.price) && currency(point.currency) && point.currency === row.currency);
}

export function productMetrics(product: ProductSummary) {
  const reference = product.reference_price;
  const current = product.last_price;
  // Preserve fractional cents for percentage goals, matching the alert engine.
  const goalCents = product.target_type === 'percent' && reference !== null && product.target_percent !== null
    ? Math.round(reference * 100) * (10000 - Math.round(product.target_percent * 100)) / 10000
    : product.target_type === 'price' && product.target_price !== null ? Math.round(product.target_price * 100) : null;
  const target = goalCents === null ? null : goalCents / 100;
  const reached = current !== null && goalCents !== null && Math.round(current * 100) <= goalCents;
  const progress = current === null || reference === null || target === null ? null : reached ? 100
    : reference <= target ? 0 : Math.max(0, Math.min(100, (reference - current) / (reference - target) * 100));
  const variation = current !== null && reference !== null && reference > 0 ? (current - reference) / reference * 100 : null;
  return { target, reached, progress, variation };
}
