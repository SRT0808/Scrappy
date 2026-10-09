import { json } from '../../lib/server/auth.js';
import { listDatabase, listsHandler, objectBody, UUID, validEmoji, validName } from '../../lib/server/lists.js';

export default listsHandler(['PATCH', 'DELETE'], async (req, res) => {
  const id = new URL(req.url ?? '', 'http://localhost').pathname.split('/').at(-1) ?? '';
  if (!UUID.test(id)) {
    json(res, 400, { error: 'Identificador de lista no válido.' });
    return;
  }
  if (req.method === 'DELETE') {
    await listDatabase('delete', { p_operation: 'delete', p_id: id });
    json(res, 200, { deleted: true });
    return;
  }
  const body = objectBody(req);
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
