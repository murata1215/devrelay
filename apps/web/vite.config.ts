import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/devrelay/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    allowedHosts: ['ribbon-re.jp', 'devrelay.io'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
