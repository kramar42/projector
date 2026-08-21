import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = `http://127.0.0.1:${process.env.PROJECTOR_PORT ?? 8092}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    // Deliberately distinct ports so this runs alongside other local tools.
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
