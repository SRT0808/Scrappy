import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ApiRequest = IncomingMessage & { body?: unknown };
export type Handler = (req: ApiRequest, res: ServerResponse) => void | Promise<void>;
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const COOKIE_NAME = '__Host-scrappy_session';

function configuration() {
  const accessKey = process.env.ACCESS_KEY;
  const secret = process.env.SESSION_SECRET;
  if (!accessKey || !secret || Buffer.byteLength(secret) < 32) {
    throw new Error('Missing or invalid server authentication configuration');
  }
  return { accessKey, secret };
}

export function matchesAccessKey(candidate: string): boolean {
  const { accessKey } = configuration();
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(candidate), digest(accessKey));
}

function signature(payload: string): Buffer {
  const { accessKey, secret } = configuration();
  // Rotating either credential invalidates existing sessions.
  const key = createHmac('sha256', secret).update(accessKey).digest();
  return createHmac('sha256', key).update(payload).digest();
}

export function createSession(now = Math.floor(Date.now() / 1000)): string {
  const payload = `v1.${now}.${now + SESSION_SECONDS}.${randomBytes(16).toString('hex')}`;
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function validSession(token: string, now = Math.floor(Date.now() / 1000)): boolean {
  if (token.length > 256) return false;
  const match = /^v1\.(\d{1,12})\.(\d{1,12})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const issued = Number(match[1]);
  const expires = Number(match[2]);
  const payload = token.slice(0, token.lastIndexOf('.'));
  const expected = signature(payload).toString('base64url');
  return timingSafeEqual(Buffer.from(match[4]), Buffer.from(expected))
    && issued <= now && expires > now && expires - issued === SESSION_SECONDS;
}

export function sessionCookie(token: string, clear = false): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${clear ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}`;
}

function readSession(req: ApiRequest): string {
  const values = (req.headers.cookie ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${COOKIE_NAME}=`));
  return values.length === 1 ? values[0].slice(COOKIE_NAME.length + 1) : '';
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

export function allowMethod(req: ApiRequest, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  json(res, 405, { error: 'Método no permitido.' });
  return false;
}

export function sameOrigin(req: ApiRequest): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !req.headers.host) return false;
  const encrypted = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted;
  const protocol = process.env.VERCEL === '1' ? 'https' : (encrypted ? 'https' : 'http');
  return origin === `${protocol}://${req.headers.host}`
    && !['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site']));
}

export function clientIp(req: ApiRequest): string {
  // Trust forwarded addresses only behind Vercel's sanitizing edge.
  const forwarded = req.headers['x-vercel-forwarded-for'];
  const ip = process.env.VERCEL === '1'
    ? (typeof forwarded === 'string' ? forwarded.trim() : '')
    : (req.socket.remoteAddress ?? '');
  if (!isIP(ip)) throw new Error('Missing trusted client address');
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function withSession(handler: Handler): Handler {
  return async (req, res) => {
    try {
      if (!validSession(readSession(req))) {
        json(res, 401, { error: 'Inicia sesión para continuar.' });
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && !sameOrigin(req)) {
        json(res, 403, { error: 'Origen de solicitud no permitido.' });
        return;
      }
      await handler(req, res);
    } catch {
      json(res, 503, { error: 'Servicio temporalmente no disponible.' });
    }
  };
}
