/**
 * Verifies synthetic defocus end to end: the depth model downloads and runs
 * (in headless Chromium that is the WebAssembly/int8 path — no WebGPU), the
 * GPU passes compile without a GL error, the print changes when the stage is
 * switched on, and the in-focus subject stays sharp while the rest softens.
 *
 *   SUBJECT=x0,y0,x1,y1 BACKDROP=x0,y0,x1,y1  *     node scripts/verify-defocus.mjs [url] [photo] [outDir]
 *
 * SUBJECT is the region to focus on and BACKDROP one that should soften, as
 * fractions of the frame; the defaults fit the street scene demo01.jpg from
 * the Depth Anything V2 Space (the bus, and the tower against the sky). The
 * photograph needs real depth — the test chart is flat. Writes the rendered
 * canvas for each state to outDir for inspection.
 *
 * DEVICE=iphone runs WebKit — Safari's engine — as an iPhone 15, which takes
 * the phone profile (model.ts, depthProfile): the CPU worker, the 392 px
 * input, the 1024 px guide and a worker torn down after the estimate.
 * WebKit here is not iOS: it proves the path runs in Safari's engine, not
 * that it fits an iPhone's memory.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173';
const photo = process.argv[3] ?? 'public/test-chart.png';
const outDir = process.argv[4] ?? 'defocus-out';
mkdirSync(outDir, { recursive: true });

const iphone = process.env.DEVICE === 'iphone';
const browser = iphone
  ? await webkit.launch()
  : await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = iphone
  ? await (await browser.newContext({ ...devices['iPhone 15'] })).newPage()
  : await browser.newPage({ viewport: { width: 2100, height: 1500 } });
const errs = [];
page.on('pageerror', (e) => {
  // WebKit reports a ResizeObserver loop that settles within the frame as a
  // page error; it predates defocus (the layout's own observers) and is not one.
  if (!e.message.includes('ResizeObserver loop')) errs.push('PAGEERR: ' + e.message);
});
page.on('console', (m) => {
  // ONNX Runtime reports its node placement as a console error; it is a note.
  if (m.type() === 'error' && !m.text().includes('onnxruntime')) errs.push('CONSOLE: ' + m.text());
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', photo);
await page.waitForSelector('.rail', { timeout: 20000 });
await page.waitForTimeout(900);

const shot = (name) => page.locator('canvas').first().screenshot({ path: join(outDir, `${name}.png`) });
/** Mean absolute gradient in a region of the canvas: a sharpness measure. */
const sharpness = (x0, y0, x1, y1) =>
  page.evaluate(
    ([x0, y0, x1, y1]) => {
      const c = document.querySelector('canvas');
      const g = c.getContext('webgl2');
      const w = c.width;
      const h = c.height;
      const buf = new Uint8Array(4 * w * h);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, buf);
      let s = 0;
      let n = 0;
      // readPixels is bottom-up; the region is given top-down in 0–1.
      for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h) - 1; y++) {
        for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w) - 1; x++) {
          const i = ((h - 1 - y) * w + x) * 4;
          const j = i + 4;
          const k = i - w * 4;
          s += Math.abs(buf[i] - buf[j]) + Math.abs(buf[i] - buf[k]);
          n++;
        }
      }
      return { grad: +(s / n).toFixed(3), glError: g.getError() };
    },
    [x0, y0, x1, y1],
  );

async function setSlider(label, v) {
  await page
    .locator('.control', { has: page.locator(`label:text-is("${label}")`) })
    .locator('input')
    .evaluate((el, val) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
}

// Focus region and a background region, as fractions of the frame; for the
// demo street scene the bus and the sky-and-tower.
const subject = (process.env.SUBJECT ?? '0.77,0.6,0.9,0.72').split(',').map(Number);
const backdrop = (process.env.BACKDROP ?? '0.08,0.05,0.2,0.4').split(',').map(Number);

await shot('0-off');
const offSubject = await sharpness(...subject);
const offBack = await sharpness(...backdrop);

await page.locator('[aria-label="Synthetic defocus"] [data-value="on"]').click();
await page.getByRole('button', { name: /Download depth model/ }).click();
const t0 = Date.now();
await page.getByRole('button', { name: 'Pick the focus point' }).waitFor({ timeout: 240000 });
const meta = await page.locator('.lens-card__meta').last().innerText();
console.log(`depth: ${meta} (${((Date.now() - t0) / 1000).toFixed(1)} s including download)`);

// Focus on the subject's centre through the Focus view, as a user would —
// entered from the Lens section, which is there on every layout (the phone
// layout hides the inspect bar).
await page.getByRole('button', { name: 'Pick the focus point' }).click();
const box = await page.locator('canvas').first().boundingBox();
await page.mouse.click(
  box.x + ((subject[0] + subject[2]) / 2) * box.width,
  box.y + ((subject[1] + subject[3]) / 2) * box.height,
);
await page.waitForTimeout(600);
await shot('1-focus-view');

await page.getByRole('button', { name: 'Done' }).click();
await setSlider('Focus distance', 1); // log10: 10 m
await setSlider('Focal length', Math.log2(85));
await setSlider('Aperture', 2); // f/1.6
await page.waitForTimeout(900);
await shot('2-85mm-f1.6');
const onSubject = await sharpness(...subject);
const onBack = await sharpness(...backdrop);

await page.locator('.control', { has: page.locator('label:text-is("Aperture blades")') }).locator('select').selectOption('6');
await setSlider('Blade curvature', 0);
await setSlider("Cat’s eye", 1);
await page.waitForTimeout(900);
await shot('3-six-blades-cateye');
const last = await sharpness(...subject);

console.log('subject sharpness  off/on:', offSubject.grad, onSubject.grad);
console.log('backdrop sharpness off/on:', offBack.grad, onBack.grad);
const subjectKept = onSubject.grad > 0.8 * offSubject.grad;
const backdropSoftened = onBack.grad < 0.7 * offBack.grad;
console.log('subject stays sharp:', subjectKept ? 'YES' : 'NO');
console.log('backdrop softens   :', backdropSoftened ? 'YES' : 'NO');
console.log('glError:', last.glError === 0 ? 'none' : last.glError);
console.log('errors:', errs.length ? errs.join(' || ') : 'none');
await browser.close();
process.exit(last.glError === 0 && errs.length === 0 && subjectKept && backdropSoftened ? 0 : 1);
