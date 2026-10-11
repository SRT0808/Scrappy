import { json } from '../../lib/server/auth.js';
import { productDatabase, productsHandler } from '../../lib/server/products.js';
import { uuidPattern } from '../../lib/product-contract.js';
import { objectBody } from '../../lib/server/lists.js';
import { isBasketDetail } from '../../src/lib/baskets.js';

export default productsHandler(['GET','PATCH'], async (req,res) => {
  const url = new URL(req.url ?? '', 'https://scrappy.local');
  const id = url.pathname.split('/').at(-1) ?? '';
  const range = url.searchParams.get('range') ?? '30';
  if (!uuidPattern.test(id) || !['7','14','30','90','all'].includes(range)
    || url.searchParams.getAll('range').length > 1 || [...url.searchParams.keys()].some(k => k !== 'range')) {
    json(res,400,{ error: 'Indica una canasta y rango válidos.' }); return;
  }
  let detail: unknown;
  if (req.method === 'PATCH') {
    const b = objectBody(req);
    if (!b || Object.keys(b).sort().join(',') !== 'product_id,quantity,version'
      || typeof b.product_id !== 'string' || !uuidPattern.test(b.product_id)
      || !(b.quantity === null || Number.isInteger(b.quantity) && Number(b.quantity) > 0 && Number(b.quantity) <= 2147483647)
      || !Number.isSafeInteger(b.version) || Number(b.version) <= 0) {
      json(res,400,{ error: 'Revisa el producto, cantidad y versión.' }); return;
    }
    await productDatabase('rpc/set_basket_item',{ p_id:id,p_product_id:b.product_id,p_quantity:b.quantity,p_version:b.version });
  }
  detail = await productDatabase('rpc/read_basket_detail',{ p_id:id,p_days:range === 'all' ? null : Number(range) });
  if (!isBasketDetail(detail) || detail.id !== id) throw new Error('Invalid basket detail');
  json(res,200,{ detail });
});
