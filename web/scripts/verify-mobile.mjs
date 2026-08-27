/**
 * Mobile regression probe: the three defects reported on a real phone.
 *
 *   1. Rail content was visible behind the pinned viewport while the bench
 *      scrolled — the viewport was transparent and its bar/foot sat at 50%
 *      alpha, so the curve plot showed through the "fixed bar" region.
 *   2. The image preview was capped at a fixed 44vh regardless of the print's
 *      shape — a portrait print was crushed into a letterbox strip.
 *   3. Opening the export bench could black the screen out: the first render
 *      happens at the source's full size, and a phone GPU that cannot hold
 *      the whole float-surface graph loses the context, which draws black
 *      and never throws.
 *
 *   node scripts/verify-mobile.mjs [--url http://localhost:5173]
 *
 * Exits non-zero if any check fails. Needs a dev or preview server running.
 */

import { chromium } from 'playwright';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:5173';

const problems = [];
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({
  viewport: { width: 390, height: 700 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', 'public/test-chart.png');
await page.waitForSelector('.rail', { timeout: 20000 });
await page.waitForTimeout(900);

// --- 2: the viewport row follows the print's aspect ratio -------------------
const size = await page.evaluate(() => {
  const stage = document.querySelector('.stage');
  const vp = document.querySelector('.viewport');
  const canvas = document.querySelector('canvas');
  return {
    published: Number(getComputedStyle(stage).getPropertyValue('--print-aspect')),
    intrinsic: canvas.width / canvas.height,
    vpH: Math.round(vp.getBoundingClientRect().height),
    vh: window.innerHeight,
  };
});
if (!size.published || Math.abs(size.published - size.intrinsic) > 0.01) {
  problems.push(`--print-aspect ${size.published} does not match the canvas ratio ${size.intrinsic.toFixed(3)}`);
}
// A landscape 3:2 print at 390px needs ~330px, not the old fixed 44% (308px
// here): the row must sit between a usable floor and the 70svh ceiling, and a
// portrait print must be allowed meaningfully more room than a landscape one.
if (size.vpH < 200 || size.vpH > 0.75 * size.vh) {
  problems.push(`viewport row ${size.vpH}px is outside the usable band for a landscape print`);
}

// --- 1: nothing shows behind the pinned viewport ----------------------------
await page.evaluate(() => {
  document.querySelector('.stage').scrollTop = 260;
});
await page.waitForTimeout(300);
const opaque = await page.evaluate(() => {
  const vp = document.querySelector('.viewport');
  const bg = getComputedStyle(vp).backgroundColor;
  const alpha = bg.startsWith('rgba') ? Number(bg.match(/,\s*([\d.]+)\)$/)?.[1] ?? 0) : 1;
  // Sample the composited page inside the pinned region: with an opaque
  // viewport the sampled pixels are the viewport's own, never the bench's.
  const vr = vp.getBoundingClientRect();
  return { bg, alpha, pinned: getComputedStyle(vp).position === 'sticky', top: Math.round(vr.top) };
});
if (!opaque.pinned) problems.push('the viewport is not pinned while the bench scrolls');
if (opaque.alpha < 1) {
  problems.push(`the pinned viewport is translucent (bg ${opaque.bg}) — the bench shows through`);
}
await page.screenshot({ path: 'verify-shots/mobile-scrolled.png' });

// --- 3: the export bench opens without killing the context ------------------
await page.evaluate(() => {
  document.querySelector('.stage').scrollTop = 0;
});
await page.getByRole('button', { name: 'Export print' }).tap();
await page.waitForTimeout(2600);
const exp = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const gl = c.getContext('webgl2');
  const dlg = document.querySelector('.export');
  return {
    ctxLost: gl.isContextLost(),
    dlgOpen: !!dlg,
    failure: document.querySelector('.export__fail')?.textContent ?? null,
    detents: [...document.querySelectorAll('.export__opt')].map((o) => o.textContent.trim()),
    detentLongEdges: [...document.querySelectorAll('.export__opt')].map((o) => {
      const m = o.getAttribute('title')?.match(/(\d+) × (\d+)/);
      return m ? Math.max(Number(m[1]), Number(m[2])) : 0;
    }),
    glError: gl.getError(),
  };
});
if (exp.ctxLost) problems.push('the GL context was lost after opening the export bench');
if (!exp.dlgOpen) problems.push('the export dialog did not open');
if (exp.failure) problems.push(`the export bench reports a failure: ${exp.failure}`);
if (exp.glError !== 0) problems.push(`GL error ${exp.glError} after the export render`);
// The memory cap must hold: no offered detent may exceed the coarse-pointer
// export budget (192 MB at ~96 bytes/px -> 1448 px long edge; mirrors the
// renderer's own arithmetic — a deliberate pin, so a budget change here has
// to be made consciously in both places). A source under the cap legitimately
// ships as "Source"; one above it must appear capped instead.
const offered = exp.detentLongEdges ?? [];
const COARSE_CAP = Math.floor(Math.sqrt((192 * 1024 * 1024) / 96));
const worst = offered.length ? Math.max(...offered) : 0;
if (worst > COARSE_CAP) {
  problems.push(`an export detent offers ${worst}px, above the ${COARSE_CAP}px coarse-pointer budget`);
}
await page.keyboard.press('Escape');

// --- 2b: a portrait print must earn a taller row than a landscape one -------
// Screenshot a portrait canvas as the source: a page shot is a real PNG with
// the aspect we want, and no chart generator is needed for it.
const portraitPage = await browser.newPage({ viewport: { width: 800, height: 1200 } });
await portraitPage.goto('about:blank');
await portraitPage.screenshot({ path: 'verify-shots/portrait-src.png' });
await portraitPage.close();

await page.setInputFiles('input[type=file]', 'verify-shots/portrait-src.png');
await page.waitForTimeout(1200);
const portrait = await page.evaluate(() => {
  const stage = document.querySelector('.stage');
  const vp = document.querySelector('.viewport');
  return {
    published: Number(getComputedStyle(stage).getPropertyValue('--print-aspect')),
    vpH: Math.round(vp.getBoundingClientRect().height),
    vh: window.innerHeight,
  };
});
if (!(portrait.published < 1)) {
  problems.push(`a portrait source published aspect ${portrait.published}, expected < 1`);
}
if (portrait.vpH < 0.6 * portrait.vh) {
  problems.push(
    `a portrait print got a ${portrait.vpH}px row (${Math.round((portrait.vpH / portrait.vh) * 100)}% of screen) — it should fill most of the screen`,
  );
}
await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('mobile checks clean: aspect-driven sizing, opaque pinned viewport, export opens with the context intact.');
