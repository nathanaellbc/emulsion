/**
 * The iPhone audit: WebKit — Safari's engine — as an iPhone 15, walked through
 * every screen the app has, with a screenshot of each and a geometric check
 * that nothing overlaps, nothing runs off the screen, and every tap target is
 * at least 44 pt (Apple's minimum).
 *
 *   node scripts/audit-iphone.mjs [url] [photo] [outDir]
 *
 * A persistent profile in outDir/profile keeps the depth model between runs,
 * so the lens screens only download it once. Exits non-zero on any finding.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { devices, webkit } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173';
const photo = process.argv[3] ?? 'public/test-chart.png';
const outDir = process.argv[4] ?? 'verify-shots/iphone';
mkdirSync(outDir, { recursive: true });

const device = { ...devices['iPhone 15'], deviceScaleFactor: 2 };
delete device.defaultBrowserType;
const context = await webkit.launchPersistentContext(join(outDir, 'profile'), device);
const page = context.pages()[0] ?? (await context.newPage());
const errs = [];
page.on('pageerror', (e) => {
  if (!e.message.includes('ResizeObserver loop')) errs.push('PAGEERR: ' + e.message);
});
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('onnxruntime')) errs.push('CONSOLE: ' + m.text());
});

const findings = [];

/**
 * Overlap, overflow and target-size check over what is on screen now. Two
 * boxes "overlap" when neither contains the other in the DOM and their
 * rectangles intersect by more than a pixel either way — text over text,
 * control over control. Elements marked data-overlay (the focus ring, the
 * seam) are allowed to sit over the picture.
 */
async function inspect(label) {
  const report = await page.evaluate(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      if (r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) return null;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.opacity === '0' || s.display === 'none') return null;
      for (let p = el; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.opacity === '0' || ps.visibility === 'hidden') return null;
      }
      return r;
    };
    // Covered by something else — content scrolled under the pinned picture,
    // the bench behind a sheet — is not on screen, whatever its box says.
    const onTop = (el, r) => {
      const pts = [
        [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
        [r.left + 2, r.top + 2],
        [r.right - 2, r.bottom - 2],
      ];
      return pts.some(([x, y]) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === el || el.contains(hit) || hit.contains(el) || hit.closest('label') === el);
      });
    };
    const leaves = [];
    const all = document.querySelectorAll(
      'button, input:not([type=range]):not([type=file]), select, a, label, output, h1, h2, p, .stat, .viewport__file, .viewport__caption, .control__value, [role=radio], [role=tab]',
    );
    for (const el of all) {
      if (el.closest('.sr-only, [aria-hidden="true"]')) continue;
      const r = visible(el);
      if (r && onTop(el, r)) leaves.push({ el, r });
    }
    const name = (el) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}「${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}」`;
    const overlaps = [];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i];
        const b = leaves[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // A label and its own control, or a radio inside its group, share a box by design.
        if (a.el.closest('label') === b.el || b.el.closest('label') === a.el) continue;
        const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (x > 1 && y > 1) overlaps.push(`${name(a.el)} × ${name(b.el)} (${x.toFixed(0)}×${y.toFixed(0)})`);
      }
    }
    const overflow = [];
    if (document.documentElement.scrollWidth > W + 1) overflow.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${W}`);
    for (const { el, r } of leaves) {
      if (r.right > W + 1 || r.left < -1) overflow.push(`${name(el)} runs off-screen (${r.left.toFixed(0)}…${r.right.toFixed(0)})`);
    }
    const small = [];
    for (const { el, r } of leaves) {
      const interactive = el.matches('button, select, a, [role=radio], [role=tab], input');
      if (!interactive || el.closest('[data-small-ok]')) continue;
      // The hit area, including an invisible ::before that extends it.
      const b = getComputedStyle(el, '::before');
      let w = r.width;
      let h = r.height;
      if (b.content !== 'none' && b.position === 'absolute') {
        w += -(parseFloat(b.left) || 0) - (parseFloat(b.right) || 0);
        h += -(parseFloat(b.top) || 0) - (parseFloat(b.bottom) || 0);
      }
      // Apple's minimum: 44 pt in both directions.
      if (w < 44 - 0.5 || h < 44 - 0.5) {
        small.push(`${name(el)} ${w.toFixed(0)}×${h.toFixed(0)}`);
      }
    }
    return { overlaps, overflow, small };
  });
  const n = report.overlaps.length + report.overflow.length + report.small.length;
  console.log(`\n[${label}] ${n ? n + ' finding(s)' : 'clean'}`);
  for (const k of ['overlaps', 'overflow', 'small']) {
    for (const f of report[k]) {
      console.log(`  ${k}: ${f}`);
      findings.push(`${label} ${k}: ${f}`);
    }
  }
}

async function shot(name) {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
}

async function scrollRailTo(selectorText) {
  await page.evaluate((t) => {
    const h = [...document.querySelectorAll('.panel-section__head .label')].find((e) => e.textContent.trim() === t);
    const section = h?.closest('.panel-section');
    // Scroll the stage (the phone's one scroller) so the section's head lands
    // just under the pinned picture.
    const stage = document.querySelector('.stage');
    const pinned = document.querySelector('.viewport')?.getBoundingClientRect().bottom ?? 0;
    if (section && stage) stage.scrollTop += section.getBoundingClientRect().top - pinned - 8;
  }, selectorText);
  await page.waitForTimeout(400);
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot('01-empty');
await inspect('empty');

await page.setInputFiles('input[type=file]', photo);
await page.waitForSelector('.rail', { timeout: 30000 });
await page.waitForTimeout(1200);
await shot('02-camera-top');
await inspect('camera, top');

await scrollRailTo('Colour');
await shot('03-camera-colour');
await inspect('camera, colour');

// The lens, switched on; the model downloads into the persistent profile once.
await scrollRailTo('Lens');
await page.locator('[aria-label="Synthetic defocus"] [data-value="on"]').click();
await page.waitForTimeout(800);
const download = page.getByRole('button', { name: /Download depth model/ });
if (await download.isVisible().catch(() => false)) await download.click();
await page.getByRole('button', { name: 'Pick the focus point' }).waitFor({ timeout: 300000 }).catch(() => {});
await scrollRailTo('Lens');
await shot('04-lens');
await inspect('lens');
await page.evaluate(() => document.querySelector('.stage')?.scrollBy(0, 360));
await page.waitForTimeout(400);
await shot('05-lens-lower');
await inspect('lens, lower');

const pick = page.getByRole('button', { name: 'Pick the focus point' });
if (await pick.isVisible().catch(() => false)) {
  await pick.scrollIntoViewIfNeeded();
  await pick.click();
  await page.waitForTimeout(700);
  await shot('06-focus-view');
  await inspect('focus view');
  const back = page.getByRole('button', { name: 'Done' });
  if (await back.isVisible().catch(() => false)) await back.click();
}

await page.getByRole('tab', { name: 'Film', exact: true }).click();
await page.waitForTimeout(500);
for (const section of ['Film', 'Development', 'Print', 'Subtractive', 'Grain', 'Halation', 'Diffusion', 'Viewing']) {
  await scrollRailTo(section);
  await shot(`07-film-${section.toLowerCase()}`);
  await inspect(`film, ${section}`);
}

await page.evaluate(() => document.querySelector('.stage')?.scrollTo(0, 0));
await page.getByRole('button', { name: 'Export print' }).click();
await page.waitForTimeout(3000);
await shot('08-export');
await inspect('export');

console.log(`\n${findings.length} finding(s); errors: ${errs.length ? errs.join(' || ') : 'none'}`);
await context.close();
process.exit(findings.length || errs.length ? 1 : 0);
