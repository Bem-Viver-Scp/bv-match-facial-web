// vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';

function esc(str: string) {
  return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ''); // carrega .env*
  const API_ORIGIN = env.VITE_API_URL || ''; // <- agora funciona

  return {
    plugins: [
      react(),
      viteStaticCopy({
        targets: [
          { src: 'node_modules/@vladmandic/face-api/model/*', dest: 'models' },
        ],
      }),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'robots.txt', 'apple-touch-icon.png'],
        manifest: {
          name: 'BV Match',
          short_name: 'BV Match',
          description: 'Reconhecimento de médicos com câmera e face descriptor',
          theme_color: '#0f172a',
          background_color: '#0b1220',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          icons: [
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
          additionalManifestEntries: [
            {
              url: '/models/tiny_face_detector_model-weights_manifest.json',
              revision: null,
            },
            {
              url: '/models/face_landmark_68_model-weights_manifest.json',
              revision: null,
            },
            {
              url: '/models/face_recognition_model-weights_manifest.json',
              revision: null,
            },
          ],
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith('/models/'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'models-cache',
                expiration: {
                  maxEntries: 80,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            ...(API_ORIGIN
              ? ([
                  {
                    // cache leve para API em produção
                    urlPattern: new RegExp('^' + esc(API_ORIGIN)),
                    handler: 'StaleWhileRevalidate',
                    options: {
                      cacheName: 'api-cache',
                      cacheableResponse: { statuses: [0, 200] },
                    },
                  },
                ] as any)
              : []),
            {
              urlPattern: ({ url }) =>
                /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url.pathname),
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'img-cache',
                expiration: {
                  maxEntries: 100,
                  maxAgeSeconds: 60 * 60 * 24 * 7,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          navigateFallback: 'index.html',
          suppressWarnings: true,
          type: 'module',
        },
      }),
    ],
    // Proxy no DEV: chamadas a /api vão para seu backend
    server: {
      proxy: {
        '/api': {
          target: API_ORIGIN || 'http://localhost:3333',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
  };
});
