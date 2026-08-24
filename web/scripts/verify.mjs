/**
 * Headless verification.
 *
 * TypeScript cannot check GLSL, so a shader that fails to compile builds
 * perfectly and then throws at runtime. This loads the built app in Chromium,
 * feeds it the test chart, and fails loudly on any console error, page error or
 * failed request — then captures the states worth looking at.
 *
 *   node scripts/verify.mjs [--url http://localhost:4173]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4173';

const OUT = 'verify-shots';
mkdirSync(OUT, { recursive: true });

const problems = [];

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

async function run(name, viewport, actions) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${name}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    if (!f.includes('ERR_ABORTED')) problems.push(`[${name}] request failed: ${r.url()} ${f}`);
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await actions(page, name);
  await page.close();
}

async function loadChart(page) {
  await page.setInputFiles('input[type=file]', 'public/test-chart.png');
  // Wait for the rail to appear, which only happens once a source decodes.
  await page.waitForSelector('.rail', { timeout: 20000 });
  await page.waitForTimeout(900);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

// Desktop: empty state, then loaded, then a few stock and stage changes.
await run('desktop', { width: 1440, height: 900 }, async (page) => {
  await page.waitForSelector('.dropzone');
  await shot(page, 'desktop-empty');

  await loadChart(page);
  await shot(page, 'desktop-portra400');

  // The GL context reports its own diagnostics; surface them.
  const info = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c?.getContext('webgl2');
    return {
      canvas: c ? [c.width, c.height] : null,
      renderer: gl?.getParameter(gl.RENDERER) ?? null,
      floatRender: !!gl?.getExtension('EXT_color_buffer_float'),
      glError: gl?.getError() ?? null,
    };
  });
  console.log('  gl:', JSON.stringify(info));
  if (info.glError) problems.push(`[desktop] glGetError = 0x${info.glError.toString(16)}`);
  if (!info.canvas || info.canvas[0] < 8) problems.push('[desktop] the canvas never sized itself');

  // Verify the render is not a flat field — a blank canvas is the classic
  // symptom of a pass that silently wrote nothing.
  const spread = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2');
    const n = 4 * c.width * c.height;
    const buf = new Uint8Array(n);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let lo = 255;
    let hi = 0;
    let sum = 0;
    for (let i = 0; i < n; i += 4) {
      lo = Math.min(lo, buf[i]);
      hi = Math.max(hi, buf[i]);
      sum += buf[i];
    }
    return { lo, hi, mean: sum / (n / 4) };
  });
  console.log('  red channel:', JSON.stringify(spread));
  if (spread.hi - spread.lo < 40) {
    problems.push(`[desktop] the render is nearly flat (red ${spread.lo}..${spread.hi})`);
  }

  // Cranking halation intensity showcases the stage on the tungsten stock.
  await page.selectOption('.panel-section:first-of-type select', 'neg.v3_500t');
  await page.waitForTimeout(700);
  await shot(page, 'desktop-halation');

  // Reversal on bypass exercises the other polarity and the short-circuit path.
  await page.selectOption('.panel-section:first-of-type select', 'rev.velvia50');
  await page.waitForTimeout(700);
  await shot(page, 'desktop-velvia');

  // Monochrome exercises the panchromatic collapse and the neutral grain.
  await page.selectOption('.panel-section:first-of-type select', 'mono.trix400');
  await page.waitForTimeout(700);
  await shot(page, 'desktop-trix');

  // Back to the reference stock, then walk the inspection stages.
  await page.selectOption('.panel-section:first-of-type select', 'neg.portra400');
  await page.waitForTimeout(500);
  for (const stage of ['Negative', 'Print D', 'Halation']) {
    await page.getByRole('radio', { name: stage, exact: true }).click();
    await page.waitForTimeout(500);
    await shot(page, `desktop-stage-${stage.toLowerCase().replace(/\s+/g, '-')}`);
  }
  await page.getByRole('radio', { name: 'Print', exact: true }).click();
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Compare' }).click();
  await page.waitForTimeout(600);
  await shot(page, 'desktop-compare');
});

// Mobile: the rail becomes a sheet below the image.
await run('mobile', { width: 390, height: 844 }, async (page) => {
  await page.waitForSelector('.dropzone');
  await shot(page, 'mobile-empty');
  await loadChart(page);
  await shot(page, 'mobile-loaded');
  await page.evaluate(() => document.querySelector('.rail')?.scrollIntoView());
  await page.waitForTimeout(400);
  await shot(page, 'mobile-panel');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 1) problems.push(`[mobile] the page scrolls horizontally by ${overflow}px`);
});

// Narrow phones: the page must never scroll horizontally, and the four stage
// buttons must stay visible rather than be pushed off the right edge. This is
// the regression guard for the segmented-control fix: below ~366px the buttons
// used to hold the page at 368px and scroll it.
for (const width of [320, 360]) {
  await run(`mobile-${width}`, { width, height: 760 }, async (page) => {
    // Empty state: the wordmark and facts grid must fit too.
    await page.waitForSelector('.dropzone');
    const emptyOver = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (emptyOver > 1) problems.push(`[mobile-${width}] empty state scrolls by ${emptyOver}px`);

    await loadChart(page);
    const m = await page.evaluate(() => {
      const last = document.querySelector('.segmented button:last-child')?.getBoundingClientRect();
      return {
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        lastBtnVisible: last ? last.right <= document.documentElement.clientWidth : false,
      };
    });
    if (m.over > 1) problems.push(`[mobile-${width}] loaded state scrolls by ${m.over}px`);
    if (!m.lastBtnVisible) problems.push(`[mobile-${width}] the last stage button is pushed off-screen`);
  });
}

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\nclean. shots in ${OUT}/`);
