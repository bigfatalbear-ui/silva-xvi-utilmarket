import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: env.VITE_APP_BASE_PATH || '/',
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/pouchdb')) return 'pouchdb'
            if (id.includes('node_modules/@supabase')) return 'supabase'
            if (id.includes('node_modules/react')) return 'react-vendor'
          }
        }
      }
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        manifest: {
          lang: 'pt-BR',
          name: 'SILVA XVI utilmarket',
          short_name: 'utilmarket',
          description: 'Gestão simples e offline para o seu comércio.',
          theme_color: '#183c32',
          background_color: '#f3f4f6',
          display: 'standalone',
          start_url: '.',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' }
          ]
        },
        workbox: {
          navigateFallback: 'index.html',
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}']
        }
      })
    ]
  }
})
