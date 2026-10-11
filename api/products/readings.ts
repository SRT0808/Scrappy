import { json } from '../../lib/server/auth.js';
import { objectBody } from '../../lib/server/lists.js';
import { dispatchReading, productDatabase, productsHandler } from '../../lib/server/products.js';
import { isReading, productUrl, uuidPattern, validConfirmation } from '../../lib/product-contract.js';

export function createReadingsHandler(dispatch = dispatchReading) {
  return productsHandler(['GET', 'POST'], async (req, res) => {
    const id = new URL(req.url!, 'https://scrappy.local').searchParams.get('id');
    if (!id || !uuidPattern.test(id)) { json(res, 400, { error: 'Indica el ID de la lectura.' }); return; }
    let reading: unknown;
    if (req.method === 'GET') {
      const rows = await productDatabase(`product_readings?id=eq.${id}&select=id,url,status,result,product_id,created_at`);
      reading = Array.isArray(rows) ? rows[0] : null;
      if (!reading) { json(res, 404, { error: 'La lectura no existe.' }); return; }
    } else {
      const body = objectBody(req);
      if (body?.action === 'confirm_repair') {
        const { action: _, ...confirmation } = body;
        if (Object.keys(confirmation).sort().join(',') !== 'candidate_index,currency,name,same_product'
          || confirmation.same_product !== true || typeof confirmation.name !== 'string'
          || !confirmation.name.trim() || [...confirmation.name.trim()].length > 300
          || typeof confirmation.currency !== 'string' || !/^[A-Z]{3}$/.test(confirmation.currency)
          || !(confirmation.candidate_index === null || (Number.isInteger(confirmation.candidate_index)
            && Number(confirmation.candidate_index) >= 0 && Number(confirmation.candidate_index) < 5))) {
          json(res, 400, { error: 'Confirma el mismo artículo, su nombre leído y moneda.' }); return;
        }
        reading = await productDatabase('rpc/confirm_product_reading', { p_id: id,
          p_confirmation: { ...confirmation, name: confirmation.name.trim() } });
      } else if (body?.action === 'confirm') {
        const { action: _, ...confirmation } = body;
        if (!validConfirmation(confirmation)) { json(res, 400, { error: 'Revisa los datos del producto.' }); return; }
        reading = await productDatabase('rpc/confirm_product_reading', { p_id: id, p_confirmation: { ...confirmation, name: confirmation.name.trim() } });
      } else if (body?.action === 'read' && productUrl(body.url)
        && (body.selector === undefined || (typeof body.selector === 'string' && body.selector.trim().length > 0 && body.selector.length <= 500))
        && (body.repair_product_id === undefined || (typeof body.repair_product_id === 'string' && uuidPattern.test(body.repair_product_id)))
        && Object.keys(body).every(key => ['action', 'url', 'selector', 'repair_product_id'].includes(key))) {
        reading = await productDatabase(body.repair_product_id ? 'rpc/create_product_repair' : 'rpc/create_product_reading', {
          p_id: id, p_url: productUrl(body.url), p_selector: typeof body.selector === 'string' ? body.selector.trim() : null,
          ...(body.repair_product_id ? { p_product_id: body.repair_product_id } : {}),
        });
        if (isReading(reading) && reading.status === 'queued') await dispatch(id);
      } else { json(res, 400, { error: 'Indica una URL HTTP(S) pública y un selector válido.' }); return; }
    }
    if (!isReading(reading)) throw new Error('Invalid reading response');
    json(res, 200, { reading });
  });
}

export default createReadingsHandler();
