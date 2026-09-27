import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Dev: forward API calls to the Hono server (same-origin in production).
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
