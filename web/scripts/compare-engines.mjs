/**
 * The two print engines, on the same photograph, measured against each other.
 *
 * Renders the test chart once through the calculated model and once through
 * the measured LUT, reads both canvases, and reports per-pixel delta-E
 * (Euclidean in display RGB — coarse, but the right order for "did the
 * engine switch change the picture and by how much"). Also drives the
 * printer lights in LUT mode to prove the control surface is live through
 * the measurement.
 *
 *   node scripts/compare-engines.mjs [--url http://localhost:4173]
 *
 * Writes verify-shots/engine-{model,lut}.png and prints the stats. The
 * engines are different by design — the model is fitted to published curve
 * parameters, the LUT is the measured stock — so the number is a character
 * distance, not an error. A broken LUT upload (swapped layout, dead texture)
 * shows up as an enormous delta; a silently-falling-back engine shows up as
 * exactly zero.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4173';

const OUT = 'verify-shots';
mkdirSync(OUT, { recursive: true });
const problems = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.dropzone');
await page.setInputFiles('input[type=file]', 'public/test-chart.png');
await page.waitForSelector('.rail', { timeout: 20000 });
// Let the LUT finish loading and the re-render settle.
await page.waitForTimeout(1500);

async function readCanvas() {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2');
    const buf = new Uint8Array(4 * c.width * c.height);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { w: c.width, h: c.height, buf: Array.from(buf) };
  });
}

async function engine(name) {
  await page.getByRole('radio', { name, exact: true }).click();
  await page.waitForTimeout(900);
  const img = await readCanvas();
  await page.screenshot({ path: `${OUT}/engine-${name === 'Measured' ? 'lut' : 'model'}.png` });
  return img;
}

const lutImg = await engine('Measured');
const modelImg = await engine('Calculated');
await engine('Measured'); // leave the app on the default engine

if (lutImg.w !== modelImg.w) problems.push('engine renders differ in size');

// Downsample both to a comparison grid and measure.
const G = 96;
const sample = (img, gx, gy) => {
  const x = Math.floor(((gx + 0.5) / G) * img.w);
  const y = Math.floor(((gy + 0.5) / G) * img.h);
  const i = 4 * (y * img.w + x);
  return [img.buf[i], img.buf[i + 1], img.buf[i + 2]];
};
const deltas = [];
let lutFlat = { lo: 255, hi: 0 };
for (let gy = 0; gy < G; gy++) {
  for (let gx = 0; gx < G; gx++) {
    const a = sample(lutImg, gx, gy);
    const b = sample(modelImg, gx, gy);
    const de = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    deltas.push(de);
    lutFlat.lo = Math.min(lutFlat.lo, a[0]);
    lutFlat.hi = Math.max(lutFlat.hi, a[0]);
  }
}
deltas.sort((x, y) => x - y);
const stats = {
  mean: deltas.reduce((s, v) => s + v, 0) / deltas.length,
  median: deltas[(deltas.length / 2) | 0],
  p95: deltas[(deltas.length * 0.95) | 0],
  max: deltas[deltas.length - 1],
};
console.log('model vs measured LUT, display RGB delta (0-255 scale):');
console.log(`  mean ${stats.mean.toFixed(2)}   median ${stats.median.toFixed(2)}   p95 ${stats.p95.toFixed(2)}   max ${stats.max.toFixed(2)}`);

if (lutFlat.hi - lutFlat.lo < 40) problems.push('the LUT render is nearly flat — the texture upload is suspect');
if (stats.mean < 0.5) problems.push('the engines rendered identically — the LUT path never engaged');
if (stats.mean > 80) problems.push(`the engines disagree enormously (mean ${stats.mean.toFixed(1)}) — the LUT upload is likely corrupt`);

// The lights must still grade the print through the measurement.
const before = await readCanvas();
const railSection = page.locator('.panel-section', { hasText: 'Printer lights' });
await railSection.locator('.stepper--r input[type=range]').fill('8');
await page.waitForTimeout(900);
const after = await readCanvas();
let changed = 0;
for (let i = 0; i < before.buf.length; i += 4) {
  if (Math.abs(before.buf[i] - after.buf[i]) > 2) changed++;
}
console.log(`  red light +8 through the LUT: ${changed} pixels moved`);
if (changed < (before.buf.length / 4) * 0.05) problems.push('printer lights do nothing through the LUT engine');

writeFileSync(`${OUT}/engine-compare.json`, JSON.stringify(stats, null, 1));
await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nengines verified.');
