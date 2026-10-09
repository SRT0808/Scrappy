import { allowMethod, json, sessionCookie, withSession } from '../lib/server/auth.js';

export default withSession((req, res) => {
  if (!allowMethod(req, res, 'POST')) return;
  res.setHeader('Set-Cookie', sessionCookie('', true));
  json(res, 200, { authenticated: false });
});
