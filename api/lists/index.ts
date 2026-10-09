import { json } from '../../lib/server/auth.js';
import { listDatabase, listsHandler, objectBody, validEmoji, validName } from '../../lib/server/lists.js';

export default listsHandler(['GET', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    json(res, 200, { lists: await listDatabase('read') });
    return;
  }
  const body = objectBody(req);
  if (!body || !validName(body.name) || !validEmoji(body.emoji)
    || Object.keys(body).some(key => !['name', 'emoji'].includes(key))) {
    json(res, 400, { error: 'Indica un nombre de 1 a 100 caracteres y un emoji de hasta 16 caracteres.' });
    return;
  }
  json(res, 201, { list: await listDatabase('create', {
    p_operation: 'create', p_name: body.name.trim(), p_emoji: body.emoji ?? null,
  }) });
});
