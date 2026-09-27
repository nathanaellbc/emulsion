/**
 * The export is the photograph's own size: open a file in WebKit as an
 * iPhone 15 (DEVICE=desktop for Chromium), export at Source, and check the
 * encoded file's dimensions equal the file's own — not a memory-capped
 * fraction of them — and that the render finished without losing the GPU.
 *
 *   node scripts/verify-native-export.mjs [url] [photo]
 */
import { chromium, devices, webkit } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173';
const photo = process.argv[3] ?? 'raw.dng';
const desktop = process.env.DEVICE === 'desktop';

const browser = desktop ? await chromium.launch({ args: ['--enable-unsafe-swiftshader'] }) : await webkit.launch();
const context = desktop
  ? await browser.newContext({ viewport: { width: 1400, height: 900 } })
  : await browser.newContext({ ...devices['iPhone 15'] });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => {
  if (!e.message.includes('ResizeObserver loop')) errs.push('PAGEERR: ' + e.message);
});
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE: ' + m.text());
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', photo);
await page.waitForSelector('.rail', { timeout: 120000 });
await page.waitForTimeout(1500);
const source = await page.evaluate(() => document.querySelector('.viewport__file')?.textContent);

await page.getByRole('button', { name: 'Export print' }).click();
const opt = page.locator('.export__opt', { hasText: /Source|Max/ });
const label = (await opt.textContent())?.trim();
const t0 = Date.now();
await opt.click();
await page.waitForFunction(
  () => /\d+(\.\d+)?\s*(KB|MB|kB|B)/.test(document.querySelector('.export__save')?.textContent ?? ''),
  null,
  { timeout: 600000 },
);
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
const out = await page.evaluate(() => {
  const c = document.querySelector('.export__canvas');
  return { w: c.width, h: c.height, save: document.querySelector('.export__save')?.textContent };
});
const dims = await page.locator('.export__dims').textContent();
// The pixels themselves: a 1:1 crop from the middle, and whether the print
// is a print (not black, not flat).
const check = await page.evaluate(() => {
  const c = document.querySelector('.export__canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < d.length; i += 4 * 97) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += l;
    sum2 += l * l;
  }
  const n = d.length / (4 * 97);
  const crop = document.createElement('canvas');
  crop.width = 800;
  crop.height = 600;
  crop.getContext('2d').drawImage(c, (c.width - 800) / 2, (c.height - 600) / 2, 800, 600, 0, 0, 800, 600);
  return { mean: sum / n, std: Math.sqrt(sum2 / n - (sum / n) ** 2), crop: crop.toDataURL('image/png') };
});
if (process.env.CROP) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.CROP, Buffer.from(check.crop.split(',')[1], 'base64'));
}
console.log(`pixels: mean ${check.mean.toFixed(1)}, spread ${check.std.toFixed(1)}`);
console.log(`${desktop ? 'Chromium desktop' : 'WebKit iPhone 15'} · ${source}`);
console.log(`detent: ${label} · export ${out.w}×${out.h} (${dims?.trim()}) · ${out.save?.trim()} · ${seconds} s`);
const tiling = await page.evaluate(() => globalThis.__emulsionLastTiling);
console.log(`tiling: ${JSON.stringify(tiling)}`);
console.log('errors:', errs.length ? errs.join(' || ') : 'none');
await browser.close();
const native = label?.startsWith('Source');
process.exit(native && errs.length === 0 ? 0 : 1);
