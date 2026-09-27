/**
 * Before/after: Compare's left half and the hold-to-peek show the file
 * untouched — whatever the bench does — and the peek comes and goes with the
 * press without eating taps or double-taps.
 *
 *   node scripts/verify-peek.mjs [url] [photo]
 *
 * Runs in WebKit as an iPhone 15 (DEVICE=desktop for Chromium).
 */
import { chromium, devices, webkit } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173';
const photo = process.argv[3] ?? 'public/test-chart.png';
const desktop = process.env.DEVICE === 'desktop';
const browser = desktop ? await chromium.launch({ args: ['--enable-unsafe-swiftshader'] }) : await webkit.launch();
const context = desktop
  ? await browser.newContext({ viewport: { width: 1400, height: 900 } })
  : await browser.newContext({ ...devices['iPhone 15'] });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => {
  if (!e.message.includes('ResizeObserver loop')) errs.push(e.message);
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', photo);
await page.waitForSelector('.rail', { timeout: 60000 });
await page.waitForTimeout(1200);

/** A coarse fingerprint of the canvas: the mean of a grid of pixels, per channel. */
const print = () =>
  page.evaluate(() => {
    const c = document.querySelector('.viewport__canvas');
    const g = c.getContext('webgl2');
    const out = [0, 0, 0];
    let n = 0;
    const b = new Uint8Array(4);
    for (let y = 0.1; y < 1; y += 0.1) {
      for (let x = 0.1; x < 1; x += 0.1) {
        g.readPixels(Math.round(x * c.width), Math.round(y * c.height), 1, 1, g.RGBA, g.UNSIGNED_BYTE, b);
        out[0] += b[0];
        out[1] += b[1];
        out[2] += b[2];
        n++;
      }
    }
    return out.map((v) => +(v / n).toFixed(1));
  });
const same = (a, b, tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function setSlider(label, v) {
  await page
    .locator('.control', { has: page.locator(`label:text-is("${label}")`) })
    .locator('input')
    .evaluate((el, val) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
  await page.waitForTimeout(400);
}

const box = await page.locator('.viewport__canvas').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

/** Hold the pointer still on the picture, read the canvas while held, release. */
async function holdAndRead(ms = 500) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  const held = await print();
  const tag = await page.locator('.viewport__peek-tag').isVisible().catch(() => false);
  await page.mouse.up();
  await page.waitForTimeout(250);
  return { held, tag };
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

// 1. The peek at the defaults, then after heavy edits: the original must not move.
const peekA = (await holdAndRead()).held;
await setSlider('Exposure', 1.5);
await setSlider('Contrast', 0.6);
await setSlider('White balance', 3200);
const edited = await print();
const { held: peekB, tag } = await holdAndRead();
check('the original ignores exposure, contrast and white balance', same(peekA, peekB), `${peekA} vs ${peekB}`);
check('holding shows the original, not the edit', !same(peekB, edited, 4), `${peekB} vs ${edited}`);
check('the "Original" tag shows while held', tag);
const after = await print();
check('letting go returns the edit', same(after, edited), `${after} vs ${edited}`);

// 2. A quick tap is not a peek.
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(60);
const midTap = await print();
await page.mouse.up();
check('a quick tap never flashes the original', same(midTap, edited), `${midTap}`);

// 3. Double-tap still zooms.
await page.waitForTimeout(400);
await page.mouse.dblclick(cx, cy, { delay: 40 });
await page.waitForTimeout(500);
const zoomed = await page.locator('.viewport__zoom').evaluate((el) => getComputedStyle(el).transform);
check('double-tap still zooms', zoomed !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(zoomed), zoomed);
await page.mouse.dblclick(cx, cy, { delay: 40 });
await page.waitForTimeout(500);

// 4. Compare's left half is the same untouched original.
await page.getByRole('button', { name: 'Compare' }).click();
await page.waitForTimeout(600);
const left = await page.evaluate(() => {
  const c = document.querySelector('.viewport__canvas');
  const g = c.getContext('webgl2');
  const b = new Uint8Array(4);
  g.readPixels(Math.round(0.2 * c.width), Math.round(0.5 * c.height), 1, 1, g.RGBA, g.UNSIGNED_BYTE, b);
  return [b[0], b[1], b[2]];
});
await page.getByRole('button', { name: 'Compare' }).click();
await page.waitForTimeout(400);
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(500);
const peekAt = await page.evaluate(() => {
  const c = document.querySelector('.viewport__canvas');
  const g = c.getContext('webgl2');
  const b = new Uint8Array(4);
  g.readPixels(Math.round(0.2 * c.width), Math.round(0.5 * c.height), 1, 1, g.RGBA, g.UNSIGNED_BYTE, b);
  return [b[0], b[1], b[2]];
});
await page.mouse.up();
check("Compare's Original half is the same untouched original", same(left, peekAt), `${left} vs ${peekAt}`);

// 5. The original IS the file: the browser's own decode of the same file,
// drawn at the canvas's size into the canvas's colour space, pixel for pixel
// against the held peek.
// (A RAW file is not something the browser can decode by itself, so there is
// no independent reference to hold it against; its checks above stand.)
const decodable = /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(photo);
const fileBytes = decodable ? [...(await import('node:fs')).readFileSync(photo)] : null;
if (fileBytes) {
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(500);
const vsFile = await page.evaluate(async (bytes) => {
  const c = document.querySelector('.viewport__canvas');
  const g = c.getContext('webgl2');
  const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  const ref = document.createElement('canvas');
  ref.width = c.width;
  ref.height = c.height;
  const r2 = ref.getContext('2d', { colorSpace: g.drawingBufferColorSpace ?? 'srgb' }) ?? ref.getContext('2d');
  r2.imageSmoothingQuality = 'high';
  r2.drawImage(bmp, 0, 0, c.width, c.height);
  let worst = 0;
  let sum = 0;
  let n = 0;
  const all = [];
  const b = new Uint8Array(4);
  for (let y = 0.05; y < 1; y += 0.05) {
    for (let x = 0.05; x < 1; x += 0.05) {
      const px = Math.round(x * c.width);
      const py = Math.round(y * c.height);
      g.readPixels(px, c.height - 1 - py, 1, 1, g.RGBA, g.UNSIGNED_BYTE, b);
      const f = r2.getImageData(px, py, 1, 1).data;
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(b[k] - f[k]);
        worst = Math.max(worst, d);
        sum += d;
        n++;
        all.push(d);
      }
    }
  }
  all.sort((p, q) => p - q);
  return { mean: sum / n, worst, median: all[Math.floor(all.length / 2)] };
}, fileBytes);
await page.mouse.up();
// Both are resamplings of one file to the same size by different filters
// (a mip chain and the 2D canvas's); edges differ by a few codes, the whole
// by well under one.
// A colour or tone difference would move the median; filter differences
// only move the tails.
check(
  'the original matches the file itself',
  vsFile.median <= 1 && vsFile.mean < 4,
  `median ${vsFile.median}, mean ${vsFile.mean.toFixed(2)}, worst ${vsFile.worst} code values (edges)`,
);
}

// 6. The keyboard's peek (desktop): hold backslash.
if (desktop) {
  await page.keyboard.down('\\');
  await page.waitForTimeout(300);
  const key = await print();
  await page.keyboard.up('\\');
  await page.waitForTimeout(300);
  check('holding \\ shows the original', same(key, peekB), `${key}`);
}

console.log('errors:', errs.length ? errs.join(' || ') : 'none');
await browser.close();
process.exit(checks.every(Boolean) && errs.length === 0 ? 0 : 1);
