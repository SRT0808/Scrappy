import { allowMethod, json, withSession } from '../lib/server/auth.js';

export default withSession((req, res) => {
  if (!allowMethod(req, res, 'GET')) return;
  json(res, 200, { authenticated: true });
});
