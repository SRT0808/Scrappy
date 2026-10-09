import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import type { Plugin } from 'vite';

// Serve the built PWA over local HTTPS alongside the original API handlers.
export function localPwa(enabled: boolean): Plugin {
  return {
    name: 'scrappy-local-pwa', apply: 'serve',
    configureServer(server) {
      if (!enabled) return;
      const root = resolve(server.config.root, 'dist');
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
        '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
        '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
      };
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'https://localhost').pathname;
        if (pathname === '/api' || pathname.startsWith('/api/')) { next(); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
        try {
          const file = resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
          if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
          const content = await readFile(file);
          res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(req.method === 'HEAD' ? undefined : content);
        } catch { res.writeHead(404).end(); }
      });
    },
  };
}
