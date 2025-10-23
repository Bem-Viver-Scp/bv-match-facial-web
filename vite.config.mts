// vite.config.mts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';

function esc(str: string) {
  return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const API_ORIGIN = env.VITE_API_URL || '';

  return {
    // para Electron / file://
    define: {
      'import.meta.env.VITE_IS_RASPBERRY': JSON.stringify(
        env.VITE_IS_RASPBERRY
      ),
    },
    base: './',
    plugins: [
      react(),
      // copia os modelos para dist/models
      viteStaticCopy({
        targets: [
          { src: 'node_modules/@vladmandic/face-api/model/*', dest: 'models' },
          {
            src: 'node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm',
            dest: 'tfjs',
          },
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
          start_url: './',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024, // 6 MiB

          globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
          // ✅ cada entry precisa de { url, revision }
          additionalManifestEntries: [
            {
              url: 'models/tiny_face_detector_model-weights_manifest.json',
              revision: null,
            },
            {
              url: 'models/face_landmark_68_model-weights_manifest.json',
              revision: null,
            },
            {
              url: 'models/face_recognition_model-weights_manifest.json',
              revision: null,
            },
          ],
          runtimeCaching: [
            // modelos (inclui .bin baixados por esses manifests)
            {
              urlPattern: /\/models\//,
              handler: 'CacheFirst' as const,
              options: {
                cacheName: 'models-cache',
                expiration: {
                  maxEntries: 80,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // API (se existir VITE_API_URL)
            ...(API_ORIGIN
              ? ([
                  {
                    urlPattern: new RegExp('^' + esc(API_ORIGIN)),
                    handler: 'StaleWhileRevalidate' as const,
                    options: {
                      cacheName: 'api-cache',
                      cacheableResponse: { statuses: [0, 200] },
                    },
                  },
                ] as any)
              : []),
            // imagens (avatars)
            {
              urlPattern: ({ url }: { url: any }) =>
                /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url.pathname),
              handler: 'StaleWhileRevalidate' as const,
              options: {
                cacheName: 'img-cache',
                expiration: {
                  maxEntries: 100,
                  maxAgeSeconds: 60 * 60 * 24 * 7,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ] as any, // <— simplifica as verificações de tipo do TS
        },
        devOptions: {
          enabled: true,
          navigateFallback: 'index.html',
          suppressWarnings: true,
          type: 'module',
        },
      }),
    ],
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
