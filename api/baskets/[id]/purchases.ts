import { json } from '../../../lib/server/auth.js';
import { readDynamicRoute } from '../../../lib/server/dynamic-route.js';
import { listsHandler, objectBody } from '../../../lib/server/lists.js';
import { PurchaseApiError, purchaseMessages, purchaseRpc, validPurchaseVersion } from '../../../lib/server/purchase-api.js';

const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export default listsHandler(['GET', 'PUT', 'POST'], async (req, res) => {
  const route = readDynamicRoute(req, 'baskets', req.method === 'GET' ? ['page', 'preview', 'request_id'] : [], '/purchases');
  if (!route) { json(res, 400, { error: 'Ruta de alternativas no válida.' }); return; }
  try {
    if (req.method === 'GET') {
      if (route.params.has('preview') || route.params.has('request_id')) {
        if ([...route.params.keys()].filter(k => k !== 'id').length !== 1 || (route.params.has('preview') ? route.params.get('preview') !== '1' : !uuid(route.params.get('request_id')))) {
          json(res, 400, { error: purchaseMessages[400] }); return;
        }
        const preview = route.params.has('preview');
        const result = await purchaseRpc(preview ? 'preview_purchase_activation' : 'read_purchase_activation',
          preview ? { p_id: route.id } : { p_id: route.id, p_request_id: route.params.get('request_id') });
        if (result.schema_version !== 2 || result.list_id !== route.id.toLowerCase()
          || (preview ? !validPurchaseVersion(result.version) || !/^[a-f0-9]{64}$/.test(String(result.token)) || !result.configuration
            : result.request_id !== route.params.get('request_id') || !Object.hasOwn(result, 'receipt'))) throw new Error('Invalid activation read');
        json(res, 200, result); return;
      }
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
    if (req.method === 'POST') {
      if (!body || Object.keys(body).sort().join(' ') !== 'configuration expected_version request_id schema_version token'
        || body.schema_version !== 2 || !validPurchaseVersion(body.expected_version) || !uuid(body.request_id)
        || typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)
        || !body.configuration || typeof body.configuration !== 'object' || Array.isArray(body.configuration)) {
        json(res, 400, { error: purchaseMessages[400] }); return;
      }
      const result = await purchaseRpc('activate_purchase_configuration', { p_id: route.id,
        p_expected_version: body.expected_version, p_request_id: body.request_id, p_token: body.token, p_configuration: body.configuration });
      if (result.schema_version !== 2 || result.list_id !== route.id.toLowerCase() || result.request_id !== body.request_id
        || result.previous_version !== body.expected_version || result.version !== (BigInt(body.expected_version) + 1n).toString()
        || (result.configuration as { version?: string })?.version !== result.version) throw new Error('Invalid activation receipt');
      json(res, 200, result); return;
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
