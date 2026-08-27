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

/** The rail opens on Camera; the film bench is the Film tab. */
async function openFilmBench(page) {
  await page.getByRole('tab', { name: 'Film', exact: true }).click();
  await page.waitForTimeout(300);
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

// Desktop: empty state, then loaded, then a few stock and stage changes.
await run('desktop', { width: 1440, height: 900 }, async (page) => {
  await page.waitForSelector('.dropzone');
  await shot(page, 'desktop-empty');

  // The rail opens on the Camera bench; switch to the film bench for the
  // stock walk. GL diagnostics first, on the camera page, which exercises the
  // prepare shader's develop branch as shipped.
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

  await openFilmBench(page);

  // Cranking halation intensity showcases the stage on the tungsten stock.
  await page.getByLabel('Negative stock').selectOption('neg.v3_500t');
  await page.waitForTimeout(700);
  await shot(page, 'desktop-halation');

  // Reversal on bypass exercises the other polarity and the short-circuit path.
  await page.getByLabel('Negative stock').selectOption('rev.velvia50');
  await page.waitForTimeout(700);
  await shot(page, 'desktop-velvia');

  // Monochrome exercises the panchromatic collapse and the neutral grain.
  await page.getByLabel('Negative stock').selectOption('mono.trix400');
  await page.waitForTimeout(700);
  await shot(page, 'desktop-trix');

  // Back to the reference stock, then walk the inspection stages.
  await page.getByLabel('Negative stock').selectOption('neg.portra400');
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

// Narrow phones: the page must never scroll horizontally, and the inspect-stage
// menu must be absent — on a phone the print is the deliverable, so the bar
// keeps only Compare/Clipping. (This guard used to assert the four stage
// buttons stayed visible; the menu's removal supersedes that fix.)
for (const width of [320, 360]) {
  await run(`mobile-${width}`, { width, height: 760 }, async (page) => {
    // Empty state: the wordmark and facts grid must fit too.
    await page.waitForSelector('.dropzone');
    const emptyOver = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (emptyOver > 1) problems.push(`[mobile-${width}] empty state scrolls by ${emptyOver}px`);

    await loadChart(page);
    const m = await page.evaluate(() => ({
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      menuHidden: (() => {
        const seg = document.querySelector('.segmented');
        return !seg || getComputedStyle(seg).display === 'none';
      })(),
      chipsPresent: document.querySelectorAll('.viewport__bar-right .chip').length,
    }));
    if (m.over > 1) problems.push(`[mobile-${width}] loaded state scrolls by ${m.over}px`);
    if (!m.menuHidden) problems.push(`[mobile-${width}] the inspect-stage menu should be hidden on phones`);
    if (m.chipsPresent < 2) {
      problems.push(`[mobile-${width}] Compare/Clipping chips missing from the bar`);
    }
  });
}

// The camera bench: the rail's default page. Moving its sliders must re-render
// without console errors, and the tone controls must measurably change the
// canvas — a develop pass that silently wrote nothing would leave the
// histogram of pixels unchanged.
await run('desktop-camera', { width: 1440, height: 900 }, async (page) => {
  await loadChart(page);

  // The Camera tab must be the selected one on load. (textContent is a
  // property, not an attribute — read it through the DOM, not getAttribute.)
  const selected = await page.evaluate(() => {
    const on = document.querySelector('[role=tab][aria-selected="true"]');
    return on?.textContent?.trim() ?? null;
  });
  if (selected !== 'Camera') {
    problems.push(`[desktop-camera] the rail opened on '${selected}' instead of Camera`);
  }

  const readCanvas = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgl2');
      const n = 4 * c.width * c.height;
      const buf = new Uint8Array(n);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0;
      for (let i = 0; i < n; i += 4) sum += buf[i];
      return sum / (n / 4);
    });

  const before = await readCanvas();

  // Move three representative develop sliders well off zero.
  await page.getByLabel('Contrast', { exact: true }).fill('0.5');
  await page.waitForTimeout(400);
  const contrasted = await readCanvas();

  await page.getByLabel('Highlights', { exact: true }).fill('-1');
  await page.waitForTimeout(400);
  await page.getByLabel('Shadows', { exact: true }).fill('1');
  await page.waitForTimeout(400);
  await page.getByLabel('Saturation', { exact: true }).fill('1.5');
  await page.waitForTimeout(400);
  await shot(page, 'desktop-camera-developed');
  const developed = await readCanvas();

  if (Math.abs(contrasted - before) < 0.5) {
    problems.push(`[desktop-camera] contrast moved the mean by ${Math.abs(contrasted - before)}`);
  }
  if (Math.abs(developed - contrasted) < 0.5) {
    problems.push(`[desktop-camera] the tone sliders moved the mean by ${Math.abs(developed - contrasted)}`);
  }
  console.log(`  develop means: base ${before.toFixed(2)} -> contrast ${contrasted.toFixed(2)} -> graded ${developed.toFixed(2)}`);

  // The Film tab must still switch and carry the stock select.
  await openFilmBench(page);
  const hasStock = await page.getByLabel('Negative stock').isVisible();
  if (!hasStock) problems.push('[desktop-camera] the film bench lost its stock select');

  // Back to camera, reset to defaults, and confirm the render returns.
  await page.getByRole('tab', { name: 'Camera', exact: true }).click();
  await page.waitForTimeout(300);
});

// Mobile camera bench: the tabs sit at the rail head and the page must not
// scroll horizontally in either state.
await run('mobile-camera', { width: 390, height: 844 }, async (page) => {
  await loadChart(page);
  const overCamera = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overCamera > 1) problems.push(`[mobile-camera] camera page scrolls by ${overCamera}px`);
  await shot(page, 'mobile-camera');

  await openFilmBench(page);
  const overFilm = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overFilm > 1) problems.push(`[mobile-camera] film page scrolls by ${overFilm}px`);
});

// Desktop export bench: the dialog must open, offer the formats this Chromium
// actually encodes, re-encode when the quality slider settles, and produce a
// download with the expected name when clicked.
await run('desktop-export', { width: 1440, height: 900 }, async (page) => {
  await loadChart(page);

  await page.getByRole('button', { name: 'Export print' }).click();
  await page.waitForSelector('[role=dialog]', { timeout: 10000 });

  // The primary button arms once the first render+encode lands.
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const dl = await download;
  const name = dl.suggestedFilename();
  if (!/\.(png|jpg|jpeg|webp|avif)$/i.test(name)) {
    problems.push(`[desktop-export] unexpected download filename '${name}'`);
  }
  console.log(`  download: ${name}`);
  await page.close();
});

// The bench must offer the formats and honour a switch to JPEG with a quality
// change: a second download whose extension follows the chosen format.
await run('desktop-export-formats', { width: 1440, height: 900 }, async (page) => {
  await loadChart(page);
  await page.getByRole('button', { name: 'Export print' }).click();
  await page.waitForSelector('[role=dialog]', { timeout: 10000 });

  // Formats are probed asynchronously; wait for the select to populate.
  // (Options themselves never count as visible to Playwright — the select is.)
  await page.waitForFunction(
    () => document.querySelectorAll('[role=dialog] select option').length >= 2,
    { timeout: 10000 },
  );
  const options = await page.$$eval('[role=dialog] select option', (els) =>
    els.map((o) => o.value),
  );
  console.log(`  formats offered: ${options.join(', ')}`);
  if (!options.includes('png')) problems.push('[desktop-export-formats] PNG is not offered');
  if (!options.includes('jpeg')) problems.push('[desktop-export-formats] JPEG is not offered');

  await page.selectOption('[role=dialog] select', 'jpeg');
  // Let the debounced re-encode settle so the button reflects the new blob.
  await page.waitForFunction(() => {
    const btns = [...document.querySelectorAll('[role=dialog] button')];
    const dl = btns.find((b) => /^Download/.test(b.textContent ?? ''));
    return !!dl && !dl.disabled;
  }, { timeout: 30000 });

  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  const dl = await download;
  if (!/\.jpe?g$/i.test(dl.suggestedFilename())) {
    problems.push(`[desktop-export-formats] expected a JPEG, got '${dl.suggestedFilename()}'`);
  } else {
    console.log(`  download: ${dl.suggestedFilename()}`);
  }
  await page.close();
});

// Mobile export: the bench becomes a bottom sheet that must never scroll the
// page horizontally, and its primary action must be reachable.
await run('mobile-export', { width: 390, height: 844 }, async (page) => {
  await loadChart(page);
  await page.getByRole('button', { name: 'Export print' }).click();
  await page.waitForSelector('[role=dialog]', { timeout: 10000 });

  const m = await page.evaluate(() => {
    const dlg = document.querySelector('[role=dialog]');
    const rect = dlg?.getBoundingClientRect();
    return {
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sheetTop: rect ? Math.round(rect.top) : null,
      inViewport: rect ? rect.bottom <= window.innerHeight + 1 : false,
    };
  });
  if (m.over > 1) problems.push(`[mobile-export] the page scrolls horizontally by ${m.over}px`);
  if (m.sheetTop === null || m.sheetTop < 0) problems.push('[mobile-export] the sheet is not anchored in view');
  if (!m.inViewport) problems.push('[mobile-export] the sheet spills below the viewport');
  await shot(page, 'mobile-export');
  await page.close();
});

// Narrow phones: the export bench must fit like everything else does.
for (const width of [320, 360]) {
  await run(`mobile-export-${width}`, { width, height: 760 }, async (page) => {
    await loadChart(page);
    await page.getByRole('button', { name: 'Export print' }).click();
    await page.waitForSelector('[role=dialog]', { timeout: 10000 });
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (over > 1) problems.push(`[mobile-export-${width}] the page scrolls horizontally by ${over}px`);
    await page.close();
  });
}

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\nclean. shots in ${OUT}/`);
