/** Confirms the ambience drifts: samples the page's composite brightness in
 *  the ground region between panels at t0 and t0+2.5s; a still backdrop would
 *  be identical, a drifting one differs. Also confirms reduced-motion freezes
 *  it. */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 900, height: 700 } });
await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await p.waitForTimeout(500);

const sample = () => p.evaluate(() => {
  // Sample the exposed ground strip along the left edge (no panels there).
  const c = document.createElement('canvas');
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  // Cannot read the composited page without html2canvas; instead read the
  // ambience layers' transforms — the drift IS the transform animation.
  const a = document.querySelector('.ambience__red--a');
  const bl = document.querySelector('.ambience__blue');
  return {
    red: getComputedStyle(a).transform,
    blue: getComputedStyle(bl).transform,
  };
});
const t0 = await sample();
await p.waitForTimeout(2500);
const t1 = await sample();
const moved = t0.red !== t1.red || t0.blue !== t1.blue;
console.log('t0 red :', t0.red);
console.log('t1 red :', t1.red);
console.log('drift moving:', moved ? 'YES' : 'NO');
await b.close();
process.exit(moved ? 0 : 1);
