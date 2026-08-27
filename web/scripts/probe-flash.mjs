/**
 * The flash regression probe.
 *
 * The renderer used to assign canvas.width/height on every render — the spec
 * clears the drawing buffer even when the size is unchanged — which blanked
 * the canvas between the clear and the next present and read as a white
 * flash on Windows/ANGLE. This probe drags a slider and samples the *live
 * composited page* (not the GL buffer) across the frames of the drag,
 * failing if any sampled frame goes white-or-blank while the print is
 * loading.
 *
 *   node scripts/probe-flash.mjs [--url http://localhost:4173]
 */

import { chromium } from 'playwright';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4173';

const problems = [];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', 'public/test-chart.png');
await page.waitForSelector('.rail', { timeout: 20000 });
await page.waitForTimeout(1200);

// Instrument before the drag: count actual drawing-buffer resets. Assigning
// width or height — even to the same value — resets the buffer per spec; this
// is the mechanism of the flash, counted directly rather than inferred from
// screenshots.
const resets = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  let count = 0;
  Object.defineProperty(canvas, 'width', {
    get: desc.get,
    set(v) {
      count++;
      desc.set.call(this, v);
    },
  });
  window.__resetCount = 0;
  window.__resetCounter = () => count;
  return count;
});
console.log(`  baseline width assignments: ${resets}`);

// Drag a Camera-bench slider the way a user would: pointer down, sweep,
// release. The render loop fires throughout.
const slider = page.getByLabel('Exposure', { exact: true });
const box = await slider.boundingBox();

await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.mouse.down();
for (let i = 0; i <= 10; i++) {
  await page.mouse.move(box.x + box.width * (i / 10), box.y + box.height * 0.5);
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.waitForTimeout(500);

const afterResets = await page.evaluate(() => window.__resetCounter());
const renders = afterResets - resets;
console.log(`  canvas width assignments during the drag: ${renders}`);
if (renders > 0) {
  problems.push(
    `${renders} drawing-buffer reset(s) during a parameter-only drag — each one is a frame the compositor has nothing to show for`,
  );
}

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nno flash: no drawing-buffer reset fired during the drag.');
