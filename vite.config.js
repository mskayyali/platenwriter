import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    // three.js is most of the bundle; keep it in its own long-lived chunk
    // two pages: the app, and "How it works" at /how-it-works/
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), how: resolve(__dirname, 'how-it-works/index.html') },
      output: { manualChunks: { three: ['three'] } },
    },
    chunkSizeWarningLimit: 700,
  },
});
