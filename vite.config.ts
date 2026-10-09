import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { localApi } from './scripts/local-api.js';
import { localPwa } from './scripts/local-pwa.js';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const certPath = process.env.LOCAL_HTTPS_CERT;
const keyPath = process.env.LOCAL_HTTPS_KEY;
if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Set both LOCAL_HTTPS_CERT and LOCAL_HTTPS_KEY.');

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), tailwindcss(), localApi(), localPwa(mode === 'pwa'),
    ...(!certPath ? [{ ...basicSsl({ name: 'scrappy-local', certDir: '.scrappy/certs' }), apply: 'serve' as const }] : []),
    VitePWA({
      disable: command === 'serve' && mode === 'pwa',
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: '/', name: 'Scrappy · Tu radar de precios', short_name: 'Scrappy',
        description: 'Tu espacio personal para seguir precios y comprar en el momento justo.',
        lang: 'es', start_url: '/', scope: '/', display: 'standalone',
        theme_color: '#090d0b', background_color: '#090d0b',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { host: 'localhost', port: 5173, strictPort: true,
    ...(certPath && keyPath ? { https: { cert: readFileSync(certPath), key: readFileSync(keyPath) } } : {}),
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['tests/web/**/*.test.tsx'],
    setupFiles: ['tests/web/setup.ts'],
    restoreMocks: true,
  },
}));
