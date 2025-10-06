// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

import { viteStaticCopy } from 'vite-plugin-static-copy';
const API_ORIGIN = process.env.VITE_API_URL || ''; // ex: 'https://api.seudominio.com'

function esc(str: string) {
  return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export default defineConfig({
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
          // modelos .bin e afins
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/models/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'models-cache',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // API do backend (se tiver VITE_API_URL definido)
          ...(API_ORIGIN
            ? ([
                {
                  urlPattern: new RegExp('^' + esc(API_ORIGIN)),
                  handler: 'StaleWhileRevalidate',
                  options: {
                    cacheName: 'api-cache',
                    cacheableResponse: { statuses: [0, 200] },
                  },
                },
              ] as any)
            : []),
          // imagens (avatars)
          {
            urlPattern: ({ url }) =>
              /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'img-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
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
  // opcional: injeta a env no client build também
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(
      process.env.VITE_API_URL || ''
    ),
  },
});
