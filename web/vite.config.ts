import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Emits `dist/sw.js` — the offline service worker — after every build.
 *
 * The worker is generated rather than hand-maintained because the heart of it
 * is the precache list: every file the build emitted, hashed chunk names
 * included, plus the static public tree. A hand-written list goes stale the
 * first time a chunk is renamed. The template lives in `service-worker.js`;
 * the two `__TOKENS__` are the cache version (this build's timestamp, so a
 * new build always installs a fresh cache) and the file list. Generated in
 * `closeBundle`, after Vite has copied `public/` into the output tree.
 */
function emulsionServiceWorker(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  return {
    name: 'emulsion:service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = join(root, config.build.outDir);
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(outDir);

      const urls = files
        .filter((f) => !f.endsWith('sw.js'))
        .map((f) => '/' + relative(outDir, f).split(sep).join('/'));
      const bytes = files.reduce((n, f) => n + statSync(f).size, 0);

      const template = readFileSync(join(root, 'service-worker.js'), 'utf8');
      const version = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '-')
        .slice(0, 13);
      const sw = template
        .replace('__CACHE_VERSION__', version)
        .replace('__PRECACHE_URLS__', JSON.stringify([...urls, '/']));

      writeFileSync(join(outDir, 'sw.js'), sw);
      console.log(
        `sw: precaching ${urls.length} files (${(bytes / 1048576).toFixed(1)} MB) as emulsion-${version}`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), emulsionServiceWorker()],
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
