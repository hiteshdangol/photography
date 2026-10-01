import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const API_TARGET = process.env.VITE_DEV_API_TARGET ?? 'http://localhost:5000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Proxying /api in dev means the browser talks to a single origin, so the
    // httpOnly refresh cookie is first-party and no CORS preflight is needed.
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/socket.io': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Vite 8 bundles with Rolldown, whose `codeSplitting.groups` replaces
        // the old object form of `manualChunks`. The three groups below are the
        // ones worth splitting: they change on very different schedules.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
            },
            { name: 'charts', test: /node_modules[\\/]recharts[\\/]/ },
            { name: 'calendar', test: /node_modules[\\/]@fullcalendar[\\/]/ },
          ],
        },
      },
    },
  },
});
