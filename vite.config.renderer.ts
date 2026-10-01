import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'development-csp',
      transformIndexHtml: {
        order: 'pre',
        handler: (html, context) => context.server
          ? html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, '')
          : html,
      },
    },
  ],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  clearScreen: false,
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
})
