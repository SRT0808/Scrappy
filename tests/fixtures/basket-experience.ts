import type { BasketDetail, Snapshot } from '../../src/lib/baskets.js';
export const basketId='11111111-1111-4111-8111-111111111111';
export const productId='22222222-2222-4222-8222-222222222222';
export function snapshots(count=10, days=14, version=2): Snapshot[] {
  return Array.from({ length: count },(_,i) => ({ id:`snapshot-${version}-${i}`,composition_version:version,
    calculated_at:new Date(Date.UTC(2026,8,20)+days*86400000*i/(count-1)).toISOString(),currency:'PEN',
    reference_total:200,current_total:100+i,savings:100-i,savings_percent:50-i/2,complete:true }));
}
export const basketDetail: BasketDetail={ id:basketId,name:'Tecnología',versions:[2,1],snapshots:[...snapshots(),...snapshots(10,14,1)],
  basket:{ budget:150,currency:'PEN',total:109,current_total:109,reference_total:200,savings:91,savings_percent:45.5,
    product_count:1,valid_count:1,complete:true,composition_version:2,calculated_at:'2026-10-04T00:00:00Z',
    stale_count:0,unavailable_count:0,missing_count:0,fx_missing_count:0,exchange_rates:[],
    lines:[{ product_id:productId,quantity:2,currency:'PEN',reference_price:100,last_price:54.5,
      last_success_at:'2026-10-04T00:00:00Z',last_checked_at:'2026-10-04T00:00:00Z',stale:false,unavailable:false,valid:true,conversion:null }] } };
