import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // libraw-wasm ships a large .wasm binary; keep it out of the eager bundle so
  // the app is interactive before a RAW file is ever chosen.
  optimizeDeps: { exclude: ['libraw-wasm'] },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: { raw: ['libraw-wasm'] },
      },
    },
  },
  worker: { format: 'es' },
});
