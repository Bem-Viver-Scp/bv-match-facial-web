// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'node_modules/@vladmandic/face-api/model/*', dest: 'models' },
      ],
    }),
    VitePWA({
      registerType: 'autoUpdate', // SW auto atualiza em background
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
        // pré-cache: tudo que o Vite gera + seus modelos
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp}'],
        additionalManifestEntries: [
          // garante cache offline dos pesos do face-api
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
          // se houver shards .bin, você pode usar um padrão (ou deixe pro runtimeCaching abaixo)
        ],
        runtimeCaching: [
          // cache /models/*.bin e quaisquer arquivos grandes baixados em tempo de execução
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/models/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'models-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 }, // 30 dias
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // backend API (match) com StaleWhileRevalidate
          {
            urlPattern: ({ url }) =>
              url.origin === import.meta.env.VITE_API_URL,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'api-cache',
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // imagens de avatar dos médicos
          {
            urlPattern: ({ url }) =>
              url.pathname.match(/\.(png|jpg|jpeg|webp|gif)$/i),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'img-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 }, // 7 dias
            },
          },
        ],
      },
      devOptions: {
        enabled: true, // ativa PWA no `npm run dev` (útil p/ testar)
        navigateFallback: 'index.html',
        suppressWarnings: true,
        type: 'module',
      },
    }),
  ],
});
