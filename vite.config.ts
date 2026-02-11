import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/dashboard',
  build: {
    outDir: resolve(__dirname, 'dist-dashboard'),
    emptyOutDir: true,
  },
  server: {
    port: 18901,
    proxy: {
      '/api': 'http://127.0.0.1:18900',
      '/ws': {
        target: 'ws://127.0.0.1:18900',
        ws: true,
      },
    },
  },
});
