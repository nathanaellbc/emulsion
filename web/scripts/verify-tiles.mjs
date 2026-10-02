/**
 * Proves the tiled export is seamless: the same print rendered as one tile
 * and as dozens of small ones must agree pixel for pixel, with every spatial
 * stage on — halation, diffusion, interlayer, grain and, if the depth model
 * can be fetched, the lens.
 *
 *   node scripts/verify-tiles.mjs [url] [photo]
 *
 * The small tiles are forced through the renderer's test hook
 * (globalThis.__emulsionTileSide). Exits non-zero if any pixel differs by
 * more than two code values — a seam shows as a line of large errors, where
 * float rounding is a scatter of one-bit ones.
 */
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173';
const photo = process.argv[3] ?? 'public/test-chart.png';

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('onnxruntime')) errs.push('CONSOLE: ' + m.text());
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', photo);
await page.waitForSelector('.rail', { timeout: 20000 });
await page.waitForTimeout(800);

async function setSlider(label, v) {
  await page
    .locator('.control', { has: page.locator(`label:text-is("${label}")`) })
    .locator('input')
    .evaluate((el, val) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
}

/** Opens the export at the source's size and returns its pixels. */
async function exportPixels(tileSide) {
  await page.evaluate((s) => {
    globalThis.__emulsionTileSide = s ?? undefined;
  }, tileSide);
  await page.getByRole('button', { name: 'Export print' }).click();
  // Forced: the sheet's spring entrance never reads as "stable" under
  // SwiftShader, and Source is the default detent anyway.
  await page.locator('.export__opt', { hasText: /Source|Max/ }).click({ force: true });
  // Rendered and encoded: the primary action carries a byte count.
  await page.waitForFunction(
    () => /\d+(\.\d+)?\s*(KB|MB|kB|B)/.test(document.querySelector('.export__save')?.textContent ?? ''),
    null,
    { timeout: 300000 },
  ).catch(async (err) => {
    console.log('stuck at:', await page.locator('.export').textContent());
    throw err;
  });
  const px = await page.evaluate(() => {
    const c = document.querySelector('.export__canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, data: Array.from(d) };
  });
  await page.getByRole('button', { name: 'Cancel' }).click({ force: true });
  await page.waitForTimeout(500);
  return px;
}

function compare(a, b, label) {
  if (a.w !== b.w || a.h !== b.h) {
    console.log(`${label}: size differs ${a.w}x${a.h} vs ${b.w}x${b.h}`);
    return false;
  }
  let worst = 0;
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > 0) differing++;
    worst = Math.max(worst, d);
  }
  const share = differing / (a.data.length / 4);
  // Where the differences are: along seams (a lattice of rows or columns)
  // or scattered (rounding). Report the busiest columns and rows.
  const cols = new Array(a.w).fill(0);
  const rows = new Array(a.h).fill(0);
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
      const p = i / 4;
      cols[p % a.w]++;
      rows[Math.floor(p / a.w)]++;
    }
  }
  const top = (arr) => arr.map((n, i) => [n, i]).sort((x, y) => y[0] - x[0]).slice(0, 6).map(([n, i]) => `${i}:${n}`).join(' ');
  console.log(`  busiest columns ${top(cols)} | rows ${top(rows)} (of ${a.h} and ${a.w} px per line)`);
  console.log(`${label}: ${a.w}x${a.h}, worst ${worst} code values, ${(share * 100).toFixed(3)}% of pixels differ`);
  // A seam would be a line of large errors; what is allowed is the scatter of
  // float rounding — a sample position computed from a different tile origin
  // lands a hair away, and a bilinear weight moves the last bit.
  return worst <= 2 && share < 0.05;
}

// Every spatial stage the film page has, turned up so a seam would show.
await page.getByRole('tab', { name: 'Film', exact: true }).click();
await setSlider('Strength', 0.19); // diffusion
await setSlider('Scatter', 2.5); // halation reach
await setSlider('Coupler activity', 2);
await page.waitForTimeout(600);

let ok = true;
const whole = await exportPixels(null);
const tiled = await exportPixels(384);
ok = compare(whole, tiled, 'film stages, 384 px tiles') && ok;

// The lens too, when the depth model is reachable.
await page.getByRole('tab', { name: 'Camera', exact: true }).click();
await page.locator('[aria-label="Synthetic defocus"] [data-value="on"]').click();
const dl = page.getByRole('button', { name: /Download depth model/ });
await dl.or(page.getByRole('button', { name: 'Pick the focus point' })).first().waitFor({ timeout: 30000 }).catch(() => {});
if (await dl.isVisible().catch(() => false)) await dl.click();
const ready = await page
  .getByRole('button', { name: 'Pick the focus point' })
  .waitFor({ timeout: 240000 })
  .then(() => true, () => false);
if (ready) {
  await setSlider('Focal length', Math.log2(85));
  await setSlider('Aperture', 2);
  await page.waitForTimeout(600);
  const wholeLens = await exportPixels(null);
  const tiledLens = await exportPixels(512);
  ok = compare(wholeLens, tiledLens, 'with the lens, 512 px tiles') && ok;
} else {
  console.log('lens: depth model unavailable, skipped');
}

console.log('errors:', errs.length ? errs.join(' || ') : 'none');
await browser.close();
process.exit(ok && errs.length === 0 ? 0 : 1);
