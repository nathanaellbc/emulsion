/**
 * The iPhone audit: WebKit — Safari's engine — as an iPhone 15, walked through
 * every screen the app has, with a screenshot of each and a geometric check
 * that nothing overlaps, nothing runs off the screen, and every tap target is
 * at least 44 pt (Apple's minimum) — and that text sits properly inside the
 * box it is drawn in: centred where a control centres it, clear of every edge,
 * and clear of a capsule's rounded ends — and that every rounded shape nested in
 * another keeps Apple's continuity: Outer radius = Inner radius + Padding.
 *
 *   node scripts/audit-iphone.mjs [url] [photo] [outDir]
 *   DEVICE=desktop node scripts/audit-iphone.mjs …   (Chromium, 1440 × 900)
 *
 * A persistent profile in outDir/profile keeps the depth model between runs,
 * so the lens screens only download it once. Exits non-zero on any finding.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173';
const photo = process.argv[3] ?? 'public/test-chart.png';
const outDir = process.argv[4] ?? 'verify-shots/iphone';
mkdirSync(outDir, { recursive: true });

const desktop = process.env.DEVICE === 'desktop';
const device = { ...devices['iPhone 15'], deviceScaleFactor: 2 };
delete device.defaultBrowserType;
const context = desktop
  ? await chromium.launchPersistentContext(join(outDir, 'profile-desktop'), {
      viewport: { width: 1440, height: 900 },
      args: ['--enable-unsafe-swiftshader'],
    })
  : await webkit.launchPersistentContext(join(outDir, 'profile'), device);
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
    // An element's box as it actually shows: cut by every ancestor that
    // clips its overflow (a scrolled inspector hides what scrolled past it,
    // whatever getBoundingClientRect says).
    const clipped = (el) => {
      const b = el.getBoundingClientRect();
      let l = b.left;
      let t = b.top;
      let r = b.right;
      let btm = b.bottom;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        l = Math.max(l, pr.left);
        t = Math.max(t, pr.top);
        r = Math.min(r, pr.right);
        btm = Math.min(btm, pr.bottom);
      }
      return { left: l, top: t, right: r, bottom: btm, width: Math.max(0, r - l), height: Math.max(0, btm - t) };
    };
    const visible = (el) => {
      const r = clipped(el);
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
      // The middle of what shows: an element half under a pinned bar is
      // judged by the part that is actually on screen.
      const c = clipped(el);
      const pts = [[(c.left + c.right) / 2, (c.top + c.bottom) / 2]];
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
        // Pinned chrome (a sticky bar) covers the content scrolling under it
        // by design, with a backing that takes no pointer events — which is
        // why elementFromPoint cannot see it. Content under a pin is not an
        // overlap.
        const pinned = (el) => {
          for (let q = el; q; q = q.parentElement) if (getComputedStyle(q).position === 'sticky') return true;
          return false;
        };
        if (pinned(a.el) !== pinned(b.el)) continue;
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
    // 44 pt is a touch rule; a pointer's controls are sized for a cursor.
    for (const { el } of matchMedia('(pointer: coarse)').matches ? leaves : []) {
      // The target's own size, not the part a scroller happens to show.
      const r = el.getBoundingClientRect();
      const interactive = el.matches('button, select, a, [role=radio], [role=tab], input');
      if (!interactive || el.closest('[data-small-ok]')) continue;
      // The hit area, including an invisible ::before that extends it.
      const b = getComputedStyle(el, '::before');
      let w = r.width;
      let h = r.height;
      if (b.content !== 'none' && b.position === 'absolute') {
        w += -(parseFloat(b.left) || 0) - (parseFloat(b.right) || 0);
        h += -(parseFloat(b.top) || 0) - (parseFloat(b.bottom) || 0);
        // A band drawn at an explicit size (centred with a transform).
        const bw = parseFloat(b.width);
        const bh = parseFloat(b.height);
        if (b.bottom === 'auto' && bh) h = Math.max(r.height, bh);
        if (b.right === 'auto' && bw) w = Math.max(r.width, bw);
      }
      // Apple's minimum: 44 pt in both directions.
      if (w < 44 - 0.5 || h < 44 - 0.5) {
        small.push(`${name(el)} ${w.toFixed(0)}×${h.toFixed(0)}`);
      }
    }

    // --- text inside its box -------------------------------------------
    // A "box" is anything drawn: a fill or a visible border. Each run of
    // text is measured against the nearest box it sits in.
    const drawn = (el) => {
      const cs = getComputedStyle(el);
      const fill = cs.backgroundColor && !/^(transparent|rgba\(\d+, \d+, \d+, 0\))$/.test(cs.backgroundColor);
      const image = cs.backgroundImage !== 'none' && !cs.backgroundImage.includes('transparent, transparent');
      const edge =
        parseFloat(cs.borderTopWidth) > 0 &&
        cs.borderTopStyle !== 'none' &&
        !/rgba\(\d+, \d+, \d+, 0\)/.test(cs.borderTopColor);
      return fill || image || edge;
    };
    const boxOf = (node) => {
      for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
        if (drawn(el)) return el;
      }
      return null;
    };
    const runs = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent.trim()) continue;
      const host = t.parentElement;
      if (!host || host.closest('.sr-only, svg, canvas, select, [aria-hidden="true"], .plot')) continue;
      const hs = getComputedStyle(host);
      // Truncated text runs past its box by design.
      if (hs.textOverflow === 'ellipsis') continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= H) continue;
      const hit = document.elementFromPoint(Math.min(W - 1, Math.max(0, r.left + 1)), Math.min(H - 1, Math.max(0, r.top + r.height / 2)));
      if (!hit || !(hit === host || host.contains(hit) || hit.contains(host))) continue;
      const box = boxOf(t);
      if (!box) continue;
      const u = runs.get(box) ?? { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity, count: 0, lh: 0, centred: false };
      u.count++;
      u.l = Math.min(u.l, r.left);
      u.t = Math.min(u.t, r.top);
      u.r = Math.max(u.r, r.right);
      u.b = Math.max(u.b, r.bottom);
      u.lh = Math.max(u.lh, parseFloat(hs.lineHeight) || parseFloat(hs.fontSize) * 1.3);
      u.centred ||= hs.textAlign === 'center';
      runs.set(box, u);
    }
    const insets = [];
    for (const [box, u] of runs) {
      const cs = getComputedStyle(box);
      const b = box.getBoundingClientRect();
      if (b.width < 1 || b.bottom <= 0 || b.top >= H) continue;
      const inner = {
        l: b.left + parseFloat(cs.borderLeftWidth),
        r: b.right - parseFloat(cs.borderRightWidth),
        t: b.top + parseFloat(cs.borderTopWidth),
        b: b.bottom - parseFloat(cs.borderBottomWidth),
      };
      const L = u.l - inner.l;
      const R = inner.r - u.r;
      const T = u.t - inner.t;
      const B = inner.b - u.b;
      const who = name(box);
      const single = u.b - u.t < u.lh * 1.6;
      // Horizontally centred by layout: a flex row's main axis, or a grid's
      // inline axis. (align-items centres vertically, not across.)
      const flexCentred =
        (/flex/.test(cs.display) && cs.flexDirection.startsWith('row') && cs.justifyContent === 'center') ||
        (/grid/.test(cs.display) && (cs.justifyItems === 'center' || cs.justifyContent === 'center'));
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      const capsule = radius >= b.height / 2 - 1 && b.height <= 64;
      // Text may never touch the box: 6 pt is the least air any Apple
      // control leaves between its label and its edge.
      const tight = Math.min(L, R) < 6 || (single && Math.min(T, B) < 2);
      if (tight) insets.push(`${who} text crowds its edge (L${L.toFixed(0)} R${R.toFixed(0)} T${T.toFixed(0)} B${B.toFixed(0)})`);
      if (single && b.height <= 64 && Math.abs(T - B) > 2.5) {
        insets.push(`${who} text off-centre vertically (T${T.toFixed(1)} B${B.toFixed(1)})`);
      }
      // One label, centred: the air either side must match.
      if ((u.centred || flexCentred) && u.count === 1 && single && b.width < W * 0.95 && Math.abs(L - R) > 2.5) {
        insets.push(`${who} text off-centre horizontally (L${L.toFixed(1)} R${R.toFixed(1)})`);
      }
      // In a capsule the label keeps clear of the curve: at least a third
      // of the height from either end.
      if (capsule && Math.min(L, R) < b.height / 3 - 0.5) {
        insets.push(`${who} text inside the capsule's curve (L${L.toFixed(0)} R${R.toFixed(0)} for height ${b.height.toFixed(0)})`);
      }
    }

    // --- corners: Outer radius = Inner radius + Padding (or Gap) ---------
    // For every drawn, rounded shape inside another drawn, rounded shape:
    //  - sitting in the outer shape's corner, the outer radius must equal
    //    the inner one plus the gap between their edges;
    //  - spanning the outer shape's width (a card in a column, not a
    //    capsule control), its radius must be the outer one less its inset.
    // Radii are effective radii: a capsule's is half its height.
    const corners = [];
    const eff = (el, r) => {
      const cs = getComputedStyle(el);
      return Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.height / 2, r.width / 2);
    };
    const seenPairs = new Set();
    for (const el of document.querySelectorAll('body *')) {
      // Geometry, not visibility: every laid-out shape is checked, on screen
      // or scrolled away, decorative thumbs included.
      if (!drawn(el) || el.closest('.sr-only, svg, canvas')) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const ri = eff(el, r);
      if (ri < 1) continue;
      let c = el.parentElement;
      while (c && c !== document.body && !(drawn(c) && eff(c, c.getBoundingClientRect()) >= 1)) c = c.parentElement;
      if (!c || c === document.body) continue;
      const cr = c.getBoundingClientRect();
      const R = eff(c, cr);
      const gl = r.left - cr.left;
      const gt = r.top - cr.top;
      const gr = cr.right - r.right;
      const gb = cr.bottom - r.bottom;
      const capsule = ri >= r.height / 2 - 0.5;
      let expected = null;
      let why = '';
      const inCorner = (a, b) => a >= -0.5 && b >= -0.5 && a < R && b < R && Math.abs(a - b) <= 2;
      if (inCorner(gl, gt)) {
        expected = R - Math.min(gl, gt);
        why = `in the corner, gap ${Math.min(gl, gt).toFixed(0)}`;
      } else if (inCorner(gr, gb)) {
        expected = R - Math.min(gr, gb);
        why = `in the corner, gap ${Math.min(gr, gb).toFixed(0)}`;
      } else if (!capsule && Math.abs(gl - gr) <= 2 && r.width >= cr.width * 0.6 && gl >= 0) {
        expected = R - gl;
        why = `across the column, inset ${gl.toFixed(0)}`;
      }
      if (expected === null) continue;
      // The rule makes parallel curves only between corners of one kind: a
      // round capsule inside a squircle panel is never concentric.
      const shape = (e) => getComputedStyle(e).getPropertyValue('corner-top-left-shape') || 'round';
      if (shape(el) !== shape(c)) {
        const key = `shape:${name(c)}>${name(el)}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          corners.push(`${name(el)} is ${shape(el)} inside ${name(c)}, which is ${shape(c)}: the curves cannot run parallel`);
        }
        continue;
      }
      expected = Math.max(0, expected);
      if (window.__auditDebug) corners.push(`CHECKED ${name(el)} r${ri.toFixed(1)} in ${name(c)} R${R.toFixed(1)} (${why}) wants r${expected.toFixed(1)}`);
      if (Math.abs(ri - expected) > 1.5) {
        const key = `${name(c)}>${name(el)}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        corners.push(`${name(el)} r${ri.toFixed(1)} in ${name(c)} R${R.toFixed(1)} (${why}): wants r${expected.toFixed(1)}`);
      }
    }

    // --- frost: glass must be able to see what is behind it -------------
    // A backdrop-filter blurs only what lies inside its nearest "backdrop
    // root": an ancestor with an opacity animation, opacity below 1, a
    // filter, a mask, a clip-path or a backdrop-filter of its own. Glass
    // inside one of those frosts nothing but that ancestor, and the page
    // shows through it sharp.
    const frost = [];
    // An entrance still playing is a backdrop root for its few hundred
    // milliseconds, which nobody sees; one that holds its fill after it ends
    // (fill: both / forwards), or never ends, is one for good.
    const fadesOpacity = (el) =>
      el
        .getAnimations()
        .some(
          (a) =>
            (a.playState === 'finished' || a.effect?.getTiming?.().iterations === Infinity) &&
            a.effect?.getKeyframes?.().some((k) => 'opacity' in k),
        );
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (!bf || bf === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const as = getComputedStyle(a);
        const why =
          (fadesOpacity(a) && 'an opacity animation') ||
          (parseFloat(as.opacity) < 1 && `opacity ${as.opacity}`) ||
          (as.filter !== 'none' && `filter ${as.filter}`) ||
          ((as.backdropFilter || as.webkitBackdropFilter || 'none') !== 'none' && 'a backdrop-filter of its own') ||
          (as.maskImage && as.maskImage !== 'none' && 'a mask') ||
          (as.clipPath && as.clipPath !== 'none' && 'a clip-path');
        if (why) {
          frost.push(`${name(el)} frosts nothing past ${name(a)}, which has ${why}`);
          break;
        }
      }
    }
    return { overlaps, overflow, small, insets, corners, frost };
  });
  const n =
    report.overlaps.length +
    report.overflow.length +
    report.small.length +
    report.insets.length +
    report.corners.length +
    report.frost.length;
  console.log(`\n[${label}] ${n ? n + ' finding(s)' : 'clean'}`);
  for (const k of ['overlaps', 'overflow', 'small', 'insets', 'corners', 'frost']) {
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
    // The phone scrolls the stage under the pinned picture; the desktop
    // scrolls the inspector on its own.
    const stage = document.querySelector('.stage');
    const rail = document.querySelector('.rail');
    const phone = stage && /auto|scroll/.test(getComputedStyle(stage).overflowY);
    if (!section) return;
    if (phone) {
      const pinned = document.querySelector('.viewport')?.getBoundingClientRect().bottom ?? 0;
      stage.scrollTop += section.getBoundingClientRect().top - pinned - 8;
    } else if (rail) {
      const top = document.querySelector('.plot')?.getBoundingClientRect().bottom ?? rail.getBoundingClientRect().top;
      rail.scrollTop += section.getBoundingClientRect().top - top - 8;
    }
  }, selectorText);
  await page.waitForTimeout(400);
}

if (process.env.AUDIT_DEBUG) await page.addInitScript(() => { window.__auditDebug = true; });
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
await page.evaluate(() => {
  const stage = document.querySelector('.stage');
  (stage && /auto|scroll/.test(getComputedStyle(stage).overflowY) ? stage : document.querySelector('.rail'))?.scrollBy(0, 360);
});
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
