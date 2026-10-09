import { allowMethod, clientIp, createSession, json, matchesAccessKey, sameOrigin, sessionCookie } from '../lib/server/auth.js';
import type { Handler } from '../lib/server/auth.js';
import { recordLoginAttempt } from '../lib/server/login-attempts.js';

const login: Handler = async (req, res) => {
  if (!allowMethod(req, res, 'POST')) return;
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'Origen de solicitud no permitido.' });
    return;
  }
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    json(res, 415, { error: 'Envía la clave en formato JSON.' });
    return;
  }
  const body = req.body;
  const candidate = body && typeof body === 'object' && 'key' in body ? body.key : undefined;
  if (typeof candidate !== 'string' || !candidate || Buffer.byteLength(candidate) > 1024) {
    json(res, 400, { error: 'La clave es obligatoria y debe tener como máximo 1024 bytes.' });
    return;
  }
  try {
    const success = matchesAccessKey(candidate);
    const retryAfter = await recordLoginAttempt(clientIp(req), success);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', retryAfter);
      json(res, 429, { error: 'Demasiados intentos. Inténtalo más tarde.' });
      return;
    }
    if (!success) {
      json(res, 401, { error: 'Clave incorrecta.' });
      return;
    }
    res.setHeader('Set-Cookie', sessionCookie(createSession()));
    json(res, 200, { authenticated: true });
  } catch {
    json(res, 503, { error: 'Servicio temporalmente no disponible.' });
  }
};

export default login;
