import { json } from '../../lib/server/auth.js';
import { listDatabase, listsHandler, objectBody, validEmoji, validName } from '../../lib/server/lists.js';
import { parseBudget } from '../../src/lib/baskets.js';
import { readDynamicRoute } from '../../lib/server/dynamic-route.js';

export default listsHandler(['PATCH', 'DELETE'], async (req, res) => {
  const route = readDynamicRoute(req, 'lists');
  if (!route) {
    json(res, 400, { error: 'Identificador de lista no válido.' });
    return;
  }
  const { id } = route;
  if (req.method === 'DELETE') {
    await listDatabase('delete', { p_operation: 'delete', p_id: id });
    json(res, 200, { deleted: true });
    return;
  }
  const body = objectBody(req);
  if (body && Object.hasOwn(body, 'basket_budget')) {
    const budget = body.basket_budget;
    const currency = body.basket_currency;
    if (Object.keys(body).some(key => !['basket_budget', 'basket_currency'].includes(key))
      || !(budget === null && currency === null || typeof budget === 'number'
        && parseBudget(String(budget)) === budget && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency))) {
      json(res, 400, { error: 'Indica un gasto máximo positivo con hasta dos decimales y una moneda de tres letras.' });
      return;
    }
    json(res, 200, { list: await listDatabase('basket', { p_id: id, p_budget: budget, p_currency: currency }) });
    return;
  }
  if (!body || !validName(body.name) || !validEmoji(body.emoji)
    || Object.keys(body).some(key => !['name', 'emoji'].includes(key))) {
    json(res, 400, { error: 'Indica un nombre de 1 a 100 caracteres y un emoji de hasta 16 caracteres.' });
    return;
  }
  json(res, 200, { list: await listDatabase('rename', {
    p_operation: 'rename', p_id: id, p_name: body.name.trim(),
    p_emoji: body.emoji ?? null, p_set_emoji: Object.hasOwn(body, 'emoji'),
  }) });
});
