import { json } from '../lib/server/auth.js';
import { listsHandler, objectBody } from '../lib/server/lists.js';
import { defaultInterval, readSettings, settingsDatabase, testNotifications } from '../lib/server/settings.js';
import { validInterval } from '../lib/settings-contract.js';

export const config = { maxDuration: 60 };
export default listsHandler(['GET', 'PATCH', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    const query = new URL(req.url ?? '/', 'https://localhost').searchParams;
    const page = query.get('page') ?? '0';
    if (!/^\d{1,5}$/.test(page) || Number(page) > 10000 || query.getAll('page').length > 1) {
      json(res, 400, { error: 'Página no válida.' }); return;
    }
    json(res, 200, query.get('view') === 'defaults' ? { default_interval_hours: await defaultInterval() } : await readSettings(Number(page)));
    return;
  }
  const body = objectBody(req);
  if (req.method === 'PATCH') {
    if (!body || Object.keys(body).length !== 1 || !validInterval(body.default_interval_hours)) {
      json(res, 400, { error: 'Elige un intervalo de 3, 6, 12 o 24 horas.' }); return;
    }
    await settingsDatabase('settings?on_conflict=key', 'POST', { key: 'default_interval_hours', value: body.default_interval_hours });
    json(res, 200, { default_interval_hours: body.default_interval_hours });
  } else {
    if (!body || body.action !== 'test' || Object.keys(body).length !== 1) {
      json(res, 400, { error: 'Acción no válida.' }); return;
    }
    json(res, 200, { deliveries: await testNotifications() });
  }
});
