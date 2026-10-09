import { json } from '../../lib/server/auth.js';
import { listDatabase, listsHandler, objectBody, UUID } from '../../lib/server/lists.js';

export default listsHandler(['PUT'], async (req, res) => {
  const body = objectBody(req);
  const ids = body?.ids;
  if (!body || Object.keys(body).some(key => key !== 'ids') || !Array.isArray(ids)
    || !ids.every(id => typeof id === 'string' && UUID.test(id))
    || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
    json(res, 400, { error: 'Envía todos los identificadores de lista, en orden y sin duplicados.' });
    return;
  }
  json(res, 200, { lists: await listDatabase('reorder', { p_operation: 'reorder', p_ids: ids }) });
});
