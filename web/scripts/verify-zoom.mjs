import { chromium } from 'playwright';

// Verifies the pinch-zoom feature: wheel zoom, mouse pan, double-click reset,
// touch pinch via CDP, touch pan when zoomed, double-tap reset, and the
// page-level zoom lock. Exits non-zero on any failed assertion.

const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const getTransform = (p) =>
  p.evaluate(() => {
    const el = document.querySelector('.viewport__zoom');
    return { transform: el.style.transform, badge: !!document.querySelector('.viewport__zoom-badge') };
  });

// --- desktop: ctrl+wheel zoom, mouse pan, double-click reset ---------------
{
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await p.setInputFiles('input[type=file]', 'public/test-chart.png');
  await p.waitForSelector('.rail', { timeout: 20000 });
  await p.waitForTimeout(600);

  const meta = await p.evaluate(() => document.querySelector('meta[name=viewport]').content);
  check('meta locks page zoom', meta.includes('user-scalable=no') && meta.includes('maximum-scale=1'));
  const bodyTouch = await p.evaluate(() => getComputedStyle(document.body).touchAction);
  check('body touch-action is pan-y', bodyTouch === 'pan-y', bodyTouch);

  const frame = await p.locator('.viewport__frame').boundingBox();
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;

  await p.mouse.move(cx, cy);
  await p.keyboard.down('Control');
  await p.mouse.wheel(0, -600);
  await p.keyboard.up('Control');
  await p.waitForTimeout(200);
  let t = await getTransform(p);
  check('ctrl+wheel zooms in', /scale\((\d+\.?\d*)\)/.test(t.transform) && !/scale\(1\)$/.test(t.transform), t.transform);
  check('zoom badge appears', t.badge);

  const before = t.transform;
  await p.mouse.move(cx - 100, cy);
  await p.mouse.down();
  await p.mouse.move(cx + 120, cy, { steps: 5 });
  await p.mouse.up();
  await p.waitForTimeout(150);
  t = await getTransform(p);
  const dx = Number(t.transform.match(/translate3d\((-?[\d.]+)px/)?.[1] ?? 0);
  check('mouse drag pans when zoomed', dx > 180, `${before} -> ${t.transform} (dx ${dx}px for a 220px drag)`);

  const clamped = await p.evaluate(() => {
    const m = document.querySelector('.viewport__zoom').style.transform.match(/translate3d\((-?[\d.]+)px, (-?[\d.]+)px/);
    return Math.abs(Number(m[1])) < 2000 && Math.abs(Number(m[2])) < 2000;
  });
  check('pan stays clamped to the frame', clamped);

  await p.mouse.dblclick(cx, cy);
  await p.waitForTimeout(400);
  t = await getTransform(p);
  check('double-click resets zoom', /scale\(1\)/.test(t.transform) && !t.badge, t.transform);
  await p.close();
}

// --- mobile: CDP pinch, pan, double-tap -------------------------------------
{
  const p = await b.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await p.setInputFiles('input[type=file]', 'public/test-chart.png');
  await p.waitForSelector('.rail', { timeout: 20000 });
  await p.waitForTimeout(600);
  const cdp = await p.context().newCDPSession(p);

  const frame = await p.locator('.viewport__frame').boundingBox();
  const cy = frame.y + frame.height / 2;
  const pinch = async (from, to) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: cx(from), y: cy },
        { x: cx(-from), y: cy },
      ],
    });
    for (const f of [from * 0.75, from * 0.5, to]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: cx(f), y: cy },
          { x: cx(-f), y: cy },
        ],
      });
      await p.waitForTimeout(40);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const cx = (offset) => frame.x + frame.width / 2 + offset;

  await pinch(60, 150);
  await p.waitForTimeout(200);
  let t = await getTransform(p);
  const s = Number(t.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
  check('two-finger pinch zooms in', s > 1.4, `scale ${s}`);

  // pan while zoomed: one-finger horizontal drag (touch-action none)
  const before = t.transform;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx(-60), y: cy }] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: cx(40), y: cy }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(150);
  t = await getTransform(p);
  const tdx = Math.abs(Number(t.transform.match(/translate3d\((-?[\d.]+)px/)?.[1] ?? 0));
  check('one-finger drag pans when zoomed', tdx > 60, `translate ${tdx}px for a 100px drag`);

  // double-tap resets
  await p.touchscreen.tap(cx(0), cy);
  await p.waitForTimeout(80);
  await p.touchscreen.tap(cx(0), cy);
  await p.waitForTimeout(500);
  t = await getTransform(p);
  check('double-tap resets zoom', /scale\(1\)/.test(t.transform) && !t.badge, t.transform);

  // compare seam rides the transform
  await p.locator('.viewport__bar-right .chip', { hasText: 'Compare' }).click();
  await p.waitForTimeout(300);
  await pinch(60, 150);
  await p.waitForTimeout(200);
  const aligned = await p.evaluate(() => {
    const canvas = document.querySelector('canvas').getBoundingClientRect();
    const handle = document.querySelector('.viewport__handle').getBoundingClientRect();
    const split = Number(document.querySelector('.viewport__handle').style.left.replace('%', '')) / 100;
    const seamX = canvas.left + canvas.width * split;
    const handleX = handle.left + handle.width / 2;
    return Math.abs(seamX - handleX) < 3;
  });
  check('seam handle stays on the seam when zoomed', aligned);
  await p.screenshot({ path: 'verify-shots/zoom-compare.png' });
  await p.close();
}

await b.close();
process.exit(failed ? 1 : 0);
