import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  // Two pages: the landing page at / and the console at /app.
  build: { rolldownOptions: { input: { main: 'index.html', app: 'app.html' } } },
  optimizeDeps: {
    // Keep MapLibre's worker next to its shared chunk. Prebundling points
    // import.meta.url at a file that has no worker beside it.
    exclude: ['maplibre-gl'],
  },
})
