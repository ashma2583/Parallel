import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  // Pre-bundling maplibre-gl breaks the URL of its web worker, and vector layers never draw.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
