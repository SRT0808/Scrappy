export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const intervals = [3, 6, 12, 24];
export type Candidate = { price: string; currency: string | null; context: string; selector?: string | null; name?: string | null };
export type ReadingResult = {
  name: string | null; price: string | null; currency: string | null; original_price: string | null;
  image_url: string | null; method: string; confidence: number; candidates: Candidate[]; warnings: string[];
};
export type Reading = {
  id: string; url: string; status: 'queued' | 'reading' | 'ready' | 'failed' | 'confirmed';
  result: ReadingResult | null; product_id: string | null; created_at: string;
};
export type Confirmation = {
  list_id: string; name: string; currency: string; candidate_index: number | null;
  reference_price: string; target_type: 'price' | 'percent'; target_value: string; check_interval_hours: number;
};

export function money(value: unknown, allowZero = false): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)
    && (allowZero ? Number(value) >= 0 : Number(value) > 0) && Number(value) <= 9999999999.99;
}

export function percentageTarget(reference: string, percent: string): string {
  const hundredths = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  };
  const cents = (hundredths(reference) * (10000n - hundredths(percent)) + 5000n) / 10000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function productUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)
      || /\.(local|localhost|internal|test|invalid)$/i.test(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function validConfirmation(value: unknown): value is Confirmation {
  if (!value || typeof value !== 'object') return false;
  const body = value as Confirmation;
  return Object.keys(body).sort().join(',') === 'candidate_index,check_interval_hours,currency,list_id,name,reference_price,target_type,target_value'
    && typeof body.list_id === 'string' && uuidPattern.test(body.list_id)
    && typeof body.name === 'string' && !!body.name.trim() && [...body.name.trim()].length <= 300
    && typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)
    && (body.candidate_index === null || (Number.isInteger(body.candidate_index) && body.candidate_index >= 0 && body.candidate_index < 5))
    && money(body.reference_price) && intervals.includes(body.check_interval_hours)
    && (body.target_type === 'price' ? money(body.target_value, true)
      : body.target_type === 'percent' && money(body.target_value) && Number(body.target_value) <= 100);
}

export function isReading(value: unknown): value is Reading {
  if (!value || typeof value !== 'object') return false;
  const row = value as Reading;
  if (!uuidPattern.test(row.id) || typeof row.url !== 'string' || !productUrl(row.url)
    || !['queued', 'reading', 'ready', 'failed', 'confirmed'].includes(row.status)
    || (row.product_id !== null && !uuidPattern.test(row.product_id))
    || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return false;
  if (row.status === 'confirmed' && !row.product_id) return false;
  if (row.result === null) return row.status !== 'ready' && row.status !== 'confirmed';
  const r = row.result;
  return (r.name === null || typeof r.name === 'string') && (r.price === null || money(r.price))
    && (r.original_price === null || money(r.original_price))
    && (r.currency === null || /^[A-Z]{3}$/.test(r.currency))
    && (r.image_url === null || typeof r.image_url === 'string')
    && typeof r.method === 'string' && Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1
    && Array.isArray(r.warnings) && r.warnings.every(w => typeof w === 'string')
    && Array.isArray(r.candidates) && r.candidates.length <= 5 && r.candidates.every(c => c && money(c.price)
      && (c.currency === null || /^[A-Z]{3}$/.test(c.currency)) && typeof c.context === 'string'
      && (c.selector === undefined || c.selector === null || typeof c.selector === 'string'));
}
