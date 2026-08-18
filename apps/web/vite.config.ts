import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  // #310: @devrelay/shared は CJS ビルド（dist/index.js）のみを持つ。
  // pnpm workspace のシンボリックリンクは realpath が node_modules の外
  // （/opt/devrelay/packages/shared/dist）になるため、Vite の
  // commonjsOptions.include（既定 [/node_modules/]）に掛からず CJS 変換されず、
  // 生の require() がバンドルに混入 → ブラウザで ReferenceError:
  // require is not defined → React が一切マウントされず全画面が真っ白になった
  // （#309 で web が初めて @devrelay/shared に依存した際の副作用、本番障害）。
  // TS ソースを直接 alias して ESM としてコンパイルさせることで
  // CJS interop 自体を発生させない。dev サーバーとビルドで同じ経路になる。
  resolve: {
    alias: {
      '@devrelay/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      manifest: {
        name: 'DevRelay',
        short_name: 'DevRelay',
        description: 'Remote AI development hub',
        theme_color: '#000000',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    allowedHosts: ['devrelay.io'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws/web': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
})
