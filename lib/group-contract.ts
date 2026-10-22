import { uuidPattern } from './product-contract.js';
import { safeWebUrl } from './home-contract.js';

export type GroupOffer = {
 id: string; name: string; domain: string; url: string; image_url: string | null; currency: string;
 reference_price: number; target_type: 'price' | 'percent'; target_value: number;
 price: number | null; checked_at: string | null; status: string; interval: number; excluded: string | null;
 history: { time: string; price: number | null }[];
};
export type GroupEvent = { id: string; kind: string; status: string; created_at: string;
 snapshot: { name: string; currency: string; target: number; price: number; offer: GroupOffer; excluded: number } };
export type ProductGroup = {
 id: string; name: string; currency: string; image_product_id: string | null; reference_price: number;
 target_type: 'price' | 'percent'; target_value: number; target: number; paused: boolean; dissolved: boolean;
 version: number; created_at: string; offers: GroupOffer[]; events: GroupEvent[];
};
export type GroupEdit = { name: string; reference_price: string; target_type: 'price' | 'percent'; target_value: string; image_product_id: string };
const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 9999999999.99;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const id = (v: unknown): v is string => typeof v === 'string' && uuidPattern.test(v);
export function validGroupEdit(v: unknown): v is GroupEdit {
 if (!v || typeof v !== 'object') return false;
 const b = v as GroupEdit;
 return typeof b.name === 'string' && b.name.trim().length > 0 && b.name.trim().length <= 300
  && typeof b.reference_price === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(b.reference_price) && Number(b.reference_price) > 0
  && typeof b.target_value === 'string' && /^\d{1,10}(\.\d{1,2})?$/.test(b.target_value)
  && (b.target_type === 'price' || b.target_type === 'percent' && Number(b.target_value) > 0 && Number(b.target_value) <= 100)
  && id(b.image_product_id);
}
export function groupEditTarget(b: GroupEdit) {
 return b.target_type === 'percent' ? Number(b.reference_price) * (1 - Number(b.target_value) / 100) : Number(b.target_value);
}
export function isGroupOffer(v: unknown): v is GroupOffer {
 if (!v || typeof v !== 'object') return false;
 const p = v as GroupOffer;
 return id(p.id) && typeof p.name === 'string' && typeof p.domain === 'string' && !!safeWebUrl(p.url)
  && (p.image_url === null || !!safeWebUrl(p.image_url)) && /^[A-Z]{3}$/.test(p.currency)
  && amount(p.reference_price) && amount(p.target_value) && ['price','percent'].includes(p.target_type)
  && (p.price === null || amount(p.price)) && (p.checked_at === null || date(p.checked_at))
  && ['active','error','paused','pending_confirmation'].includes(p.status) && [3,6,12,24].includes(p.interval)
  && (p.excluded === null || typeof p.excluded === 'string') && Array.isArray(p.history)
  && p.history.every(h => h && date(h.time) && (h.price === null || amount(h.price)));
}
export function isProductGroup(v: unknown): v is ProductGroup {
 if (!v || typeof v !== 'object') return false;
 const g = v as ProductGroup;
 return id(g.id) && typeof g.name === 'string' && g.name.length > 0 && /^[A-Z]{3}$/.test(g.currency)
  && (g.image_product_id === null || id(g.image_product_id)) && amount(g.reference_price) && amount(g.target_value) && amount(g.target)
  && ['price','percent'].includes(g.target_type) && typeof g.paused === 'boolean' && typeof g.dissolved === 'boolean'
  && Number.isSafeInteger(g.version) && g.version > 0 && date(g.created_at)
  && Array.isArray(g.offers) && g.offers.every(p => isGroupOffer(p) && p.currency === g.currency)
  && Array.isArray(g.events) && g.events.every(e => e && id(e.id) && date(e.created_at)
   && ['claimed','sent','failed'].includes(e.status) && ['goal_reached','dropped_further'].includes(e.kind)
   && e.snapshot && typeof e.snapshot.name === 'string' && e.snapshot.currency === g.currency
   && amount(e.snapshot.target) && amount(e.snapshot.price) && Number.isInteger(e.snapshot.excluded)
   && isGroupOffer({ ...e.snapshot.offer, history: [] }));
}
export function bestGroupOffer(g: ProductGroup) {
 return g.offers.filter(p => p.excluded === null && p.price !== null)
  .sort((a,b) => a.price! - b.price! || a.id.localeCompare(b.id))[0];
}
