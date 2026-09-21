import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Dev server proxies the API to a running job host; production is served by the host itself.
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/v1': { target: process.env.ONIONSOUP_HOST ?? 'http://127.0.0.1:8787', changeOrigin: false } },
  },
});
