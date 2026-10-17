import { json } from '../../../lib/server/auth.js';
import { readDynamicRoute } from '../../../lib/server/dynamic-route.js';
import { listsHandler, objectBody } from '../../../lib/server/lists.js';
import { PurchaseApiError, purchaseMessages, purchaseRpc, validPurchaseVersion } from '../../../lib/server/purchase-api.js';

export default listsHandler(['GET', 'PUT'], async (req, res) => {
  const route = readDynamicRoute(req, 'baskets', req.method === 'GET' ? ['page'] : [], '/purchases');
  if (!route) { json(res, 400, { error: 'Ruta de alternativas no válida.' }); return; }
  try {
    if (req.method === 'GET') {
      const page = route.params.get('page') ?? '0';
      if (!/^\d{1,5}$/.test(page) || Number(page) > 10000) {
        json(res, 400, { error: 'Página no válida.' }); return;
      }
      const result = await purchaseRpc('read_purchase_configuration', { p_id: route.id, p_page: Number(page) });
      if (result.schema_version !== 2 || result.list_id !== route.id.toLowerCase() || !validPurchaseVersion(result.version)
        || !['legacy', 'alternatives'].includes(String(result.mode)) || !Array.isArray(result.events)
        || typeof result.has_more !== 'boolean' || !Object.hasOwn(result, 'latest_evaluation')
        || !Object.hasOwn(result, 'configuration') || !Object.hasOwn(result, 'stale_reason')) throw new Error('Invalid purchase read');
      json(res, 200, result);
      return;
    }
    const body = objectBody(req);
    if (Buffer.byteLength(JSON.stringify(req.body) ?? '') > 262144) {
      json(res, 413, { error: 'Solicitud demasiado grande.' }); return;
    }
    if (!body || Object.keys(body).sort().join(' ') !== 'configuration expected_version schema_version'
      || body.schema_version !== 2 || !validPurchaseVersion(body.expected_version)
      || !body.configuration || typeof body.configuration !== 'object' || Array.isArray(body.configuration)) {
      json(res, 400, { error: purchaseMessages[400] }); return;
    }
    const configuration = await purchaseRpc('save_purchase_configuration', {
      p_id: route.id, p_expected_version: body.expected_version, p_configuration: body.configuration,
    });
    if (configuration.schema_version !== 2 || configuration.version !== (BigInt(body.expected_version) + 1n).toString()) {
      throw new Error('Invalid purchase publication');
    }
    json(res, 200, { schema_version: 2, configuration });
  } catch (error) {
    if (!(error instanceof PurchaseApiError)) throw error;
    json(res, error.status, { error: purchaseMessages[error.status] });
  }
});
