/**
 * Offline verification.
 *
 * The other verify scripts assume the network. This one proves the opposite:
 * that once the service worker has installed, the whole laboratory — shell,
 * chunks, LibRaw wasm, print-stock LUTs — runs with the origin server dead.
 * Not emulated-offline (context.setOffline has known gaps around service
 * workers); the preview server is actually closed, so nothing is listening.
 *
 *   node scripts/verify-offline.mjs
 *
 * It fails loudly if any console error, page error or failed request occurs
 * while offline, or if the RAW decode of `raw.dng` does not complete.
 */

import { chromium } from 'playwright';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4173, strictPort: true } });
const url = server.resolvedUrls.local[0] ?? 'http://localhost:4173/';

const problems = [];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  serviceWorkers: 'allow',
});

const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => {
  problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
});

// --- 1. Install: load once online, wait for the worker to activate and claim.
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), undefined, {
  timeout: 30000,
});
const claimed = await page.waitForFunction(
  () => navigator.serviceWorker.controller !== null,
  undefined,
  { timeout: 15000 },
);
if (!claimed) problems.push('service worker activated but never claimed the page');

// --- 2. A controlled reload, so every subsequent request rides the worker.
await page.reload({ waitUntil: 'networkidle' });
const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
if (!controlled) problems.push('page is not controlled after reload');

// --- 3. Cut the origin. Everything from here on must come from the cache.
await server.httpServer.close();

await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#root > *', { timeout: 15000 });
const shellOffline = await page.evaluate(() => ({
  title: document.title,
  mounted: document.getElementById('root')?.children.length ?? 0,
}));
if (shellOffline.mounted === 0) problems.push('offline reload rendered an empty shell');

// --- 4. A print-stock LUT, fetched while the server is dead.
const lutOk = await page.evaluate(() =>
  fetch('/luts/kodak-2383-d65.cube').then((r) => r.ok).catch(() => false),
);
if (!lutOk) problems.push('LUT fetch failed offline');

// --- 5. The RAW path offline: dynamic import of the raw chunk, wasm
//        instantiation, LibRaw decode — the pipeline's own front door.
await page.setInputFiles('input[type=file]', 'raw.dng');
await page.waitForSelector('.rail', { timeout: 60000 });

// --- 6. And the recipe survived the offline relaunch.
const recipeOffline = await page.evaluate(() => localStorage.length > 0);
if (!recipeOffline) problems.push('localStorage is empty offline');

await browser.close();
// The origin server was already shut mid-test; close() would only report that.
try {
  await server.close();
} catch {}

if (problems.length > 0) {
  console.error('OFFLINE VERIFICATION FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('offline verification passed: shell, LUT and RAW decode all served from the cache');
