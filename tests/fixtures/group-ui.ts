import type { ProductGroup } from '../../lib/group-contract.js';
import type { ProductSummary } from '../../lib/home-contract.js';
export const groupId = '11111111-1111-4111-8111-111111111111';
export const offerId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
export function groupFixture(): ProductGroup {
 const now = new Date().toISOString();
 const offers = [1,2].map(n => ({id:offerId(n),name:'Limpiador 200 ml',domain:`tienda${n}.pe`,url:`https://tienda${n}.pe/item`,image_url:null,currency:'PEN',reference_price:n===1?67.5:69.9,
  target_type:'price' as const,target_value:40,price:n===1?40:45,checked_at:now,status:'active',interval:3,excluded:null,
  history:[{time:new Date(Date.now()-10*86400000).toISOString(),price:60},{time:now,price:n===1?40:45}]}));
 return {id:groupId,name:'Limpiador compartido',currency:'PEN',image_product_id:offerId(1),reference_price:69.9,target_type:'percent',target_value:40,target:41.94,paused:false,dissolved:false,version:1,created_at:now,offers,
  events:[{id:offerId(8),kind:'goal_reached',status:'sent',created_at:now,snapshot:{name:'Limpiador compartido',currency:'PEN',target:41.94,price:40,offer:offers[0],excluded:0}}]};
}
export function productFixture(n: number): ProductSummary {
 const p = groupFixture().offers[n===2?1:0];
 return {id:offerId(n),list_id:null,name:p.name,url:p.url,domain:p.domain,image_url:null,currency:'PEN',reference_price:p.reference_price,
  target_type:'price',target_price:40,target_percent:null,last_price:p.price,status:'active',created_at:new Date().toISOString(),last_checked_at:p.checked_at,last_success_at:p.checked_at,history:[]};
}
