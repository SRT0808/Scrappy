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
      if (body?.action === 'confirm') {
        const { action: _, ...confirmation } = body;
        if (!validConfirmation(confirmation)) { json(res, 400, { error: 'Revisa los datos del producto.' }); return; }
        reading = await productDatabase('rpc/confirm_product_reading', { p_id: id, p_confirmation: { ...confirmation, name: confirmation.name.trim() } });
      } else if (body?.action === 'read' && productUrl(body.url)
        && (body.selector === undefined || (typeof body.selector === 'string' && body.selector.trim().length > 0 && body.selector.length <= 500))
        && Object.keys(body).every(key => ['action', 'url', 'selector'].includes(key))) {
        reading = await productDatabase('rpc/create_product_reading', { p_id: id, p_url: productUrl(body.url), p_selector: typeof body.selector === 'string' ? body.selector.trim() : null });
        if (isReading(reading) && reading.status === 'queued') await dispatch(id);
      } else { json(res, 400, { error: 'Indica una URL HTTP(S) pública y un selector válido.' }); return; }
    }
    if (!isReading(reading)) throw new Error('Invalid reading response');
    json(res, 200, { reading });
  });
}

export default createReadingsHandler();
