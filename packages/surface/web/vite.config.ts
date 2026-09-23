import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The UI is built into web/dist and served by the surface server; in development Vite proxies the API to it.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5747, proxy: { '/api': { target: 'http://127.0.0.1:4747', changeOrigin: false } } },
});
