import { json, type Handler } from '../lib/server/auth.js';
import login from '../lib/server/endpoints/login.js';
import logout from '../lib/server/endpoints/logout.js';

// Share one Vercel Function while retaining both public authentication routes.
const handler: Handler = async (req, res) => {
  const url = new URL(req.url ?? '/', 'https://scrappy.local');
  let path: string;
  try { path = decodeURIComponent(url.pathname).replace(/\/$/, ''); }
  catch { json(res, 404, { error: 'Ruta no encontrada.' }); return; }
  const route = /^\/api\/(login|logout)$/.exec(path)?.[1];
  const rewritten = /^\/api\/\[auth\](?:\.ts)?$/.test(path);
  const values = url.searchParams.getAll('auth');
  const action = route ?? (rewritten && values.length === 1 ? values[0] : undefined);
  if (!['login', 'logout'].includes(action ?? '') || values.length > 1
    || (values.length === 1 && values[0] !== action)) {
    json(res, 404, { error: 'Ruta no encontrada.' }); return;
  }
  await (action === 'login' ? login : logout)(req, res);
};

export default handler;
