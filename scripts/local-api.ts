import type { Plugin } from 'vite';
import { json } from '../lib/server/auth.js';
import type { ApiRequest, Handler } from '../lib/server/auth.js';
import { localReadings } from './local-readings.js';

const routes: Record<string, string> = {
  '/api/settings': '/api/settings.ts',
  '/api/login': '/api/login.ts',
  '/api/logout': '/api/logout.ts',
  '/api/session': '/api/session.ts',
  '/api/lists': '/api/lists/index.ts',
  '/api/lists/reorder': '/api/lists/reorder.ts',
  '/api/products': '/api/products/index.ts',
  '/api/products/readings': '/api/products/readings.ts',
};

// Development only: keep the deployed handlers and their security checks intact.
export function localApi(): Plugin {
  return {
    name: 'scrappy-local-api',
    apply: 'serve',
    configureServer(server) {
      if (process.env.VERCEL === '1') {
        throw new Error('Local development requires VERCEL to be unset.');
      }
      const readings = localReadings(server.config.root);
      server.httpServer?.once('close', () => readings.close());
      server.middlewares.use(async (incoming, res, next) => {
        const pathname = new URL(incoming.url ?? '/', 'https://localhost').pathname;
        if (pathname !== '/api' && !pathname.startsWith('/api/')) { next(); return; }
        const path = pathname.replace(/\/$/, '');
        const modulePath = routes[path] ?? (/^\/api\/lists\/[^/]+$/.test(path) ? '/api/lists/[id].ts'
          : /^\/api\/products\/[^/]+$/.test(path) ? '/api/products/[id].ts' : undefined);
        if (!modulePath) { json(res, 404, { error: 'Ruta no encontrada.' }); return; }
        const req = incoming as ApiRequest;
        // Browsers use HTTP/2 over local TLS: :authority replaces Host.
        // Adapt the transport to the HTTP/1 request shape expected by the handlers.
        if (req.httpVersionMajor === 2 && !req.headers.host
          && typeof req.headers[':authority'] === 'string') {
          req.headers.host = req.headers[':authority'];
        }
        try {
          if (['POST', 'PATCH', 'PUT'].includes(req.method ?? '')) {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req.iterator({ destroyOnReturn: false })) {
              size += Buffer.byteLength(chunk);
              if (size > 1024 * 1024) {
                res.setHeader('Connection', 'close');
                req.resume();
                json(res, 413, { error: 'Solicitud demasiado grande.' });
                return;
              }
              chunks.push(Buffer.from(chunk));
            }
            if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json') {
              try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
              catch { json(res, 400, { error: 'JSON no válido.' }); return; }
            }
          }
          const module = await server.ssrLoadModule(modulePath) as { default: Handler;
            createReadingsHandler?: (dispatch: (id: string) => Promise<void>) => Handler;
            createProductHandler?: (dispatch: (id: string) => Promise<void>) => Handler };
          const handler = module.createReadingsHandler?.(readings.dispatch) ?? module.createProductHandler?.(readings.dispatchProduct) ?? module.default;
          await handler(req, res);
        } catch {
          if (!res.writableEnded) json(res, 503, { error: 'Servicio temporalmente no disponible.' });
        }
      });
    },
  };
}
