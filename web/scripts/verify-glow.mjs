/** Verifies the diffusion (glow) GPU pass: compiles, no GL error, and changes
 * the render when strength is raised. */
import { chromium } from 'playwright';
const url = 'http://localhost:4173';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', 'public/test-chart.png');
await page.waitForSelector('.rail', { timeout: 20000 });
await page.waitForTimeout(900);

const grab = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const g = c.getContext('webgl2');
  const buf = new Uint8Array(4 * c.width * c.height);
  g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, buf);
  let s = 0;
  for (let i = 0; i < buf.length; i += 4) s += buf[i];
  return { mean: (s / (buf.length / 4)).toFixed(3), glError: g.getError() };
});

async function setSlider(label, v) {
  await page.locator('.control', { has: page.locator(`label:text-is("${label}")`) }).locator('input').evaluate((el, val) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
}

const off = await grab();
await setSlider('Strength', 0.19);
await page.waitForTimeout(900);
const on = await grab();

console.log('glow OFF  :', JSON.stringify(off));
console.log('glow 0.19 :', JSON.stringify(on));
console.log('glError   :', on.glError === 0 ? 'none' : on.glError);
console.log('render changes with strength:', off.mean !== on.mean ? 'YES (stage is live)' : 'NO (suspect)');
console.log('errors:', errs.length ? errs.join(' || ') : 'none');
await browser.close();
process.exit(on.glError === 0 && errs.length === 0 ? 0 : 1);
