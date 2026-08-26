import { chromium } from 'playwright';

// Probes the layout at a matrix of viewports and reports any container
// overflow: horizontal page scroll, canvas escaping its frame, or controls
// pushed out of reach. Fails non-zero if anything escapes.

const VIEWPORTS = [
  { name: 'phone-s', w: 320, h: 568 },   // iPhone SE
  { name: 'phone-m', w: 375, h: 667 },
  { name: 'phone-l', w: 414, h: 896 },
  { name: 'phone-360', w: 360, h: 640 },
  { name: 'fold-inner', w: 712, h: 1138 },
  { name: 'tablet', w: 820, h: 1180 },
  { name: 'landscape-phone', w: 896, h: 414 },
  { name: 'landscape-phone-s', w: 667, h: 375 },
  { name: 'laptop', w: 1280, h: 800 },
];

const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
let failures = 0;

for (const v of VIEWPORTS) {
  for (const withImage of [true, false]) {
    const p = await b.newPage({
      viewport: { width: v.w, height: v.h },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    await p.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    if (withImage) {
      await p.setInputFiles('input[type=file]', 'public/test-chart.png');
      await p.waitForSelector('.rail', { timeout: 20000 });
    }
    await p.waitForTimeout(700);
    const m = await p.evaluate(() => {
      const doc = document.documentElement;
      const canvas = document.querySelector('canvas');
      const frame = document.querySelector('.viewport__frame');
      const cr = canvas?.getBoundingClientRect();
      const fr = frame?.getBoundingClientRect();
      // canvas must sit inside its frame's *padding box minus padding* —
      // i.e. inside the frame rect itself, with no escape on any side.
      const escapes =
        cr && fr
          ? {
              left: +(fr.left - cr.left).toFixed(1),
              right: +(cr.right - fr.right).toFixed(1),
              top: +(fr.top - cr.top).toFixed(1),
              bottom: +(cr.bottom - fr.bottom).toFixed(1),
            }
          : null;
      const canvasEscapes = cr && fr
        ? escapes.left > 0.5 || escapes.right > 0.5 || escapes.top > 0.5 || escapes.bottom > 0.5
        : false;
      // any element wider than the document client width? SVG internals are
      // skipped: their getBoundingClientRect ignores clipPath, so a clipped
      // histogram path reports geometry far outside its viewBox.
      const wide = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.ownerSVGElement) continue;
        const r = el.getBoundingClientRect();
        if (r.width > doc.clientWidth + 1 && r.height > 0) {
          wide.push(`${el.className && String(el.className) || el.tagName} ${Math.round(r.width)}px`);
        }
      }
      return {
        clientW: doc.clientWidth,
        scrollW: doc.scrollWidth,
        horizScroll: doc.scrollWidth > doc.clientWidth + 1,
        pageScrollH: doc.scrollHeight,
        vh: window.innerHeight,
        canvas: cr ? `${Math.round(cr.width)}x${Math.round(cr.height)}` : null,
        frame: fr ? `${Math.round(fr.width)}x${Math.round(fr.height)}` : null,
        escapes,
        canvasEscapes,
        wide: wide.slice(0, 5),
      };
    });
    const bad = m.horizScroll || m.canvasEscapes;
    if (bad) failures++;
    console.log(
      `${bad ? 'FAIL' : 'ok  '} ${v.name.padEnd(18)} ${withImage ? 'img' : 'empty'} ` +
        `scrollW ${m.scrollW}/${m.clientW}` +
        (m.horizScroll ? ' H-OVERFLOW' : '') +
        (m.canvasEscapes ? ` CANVAS ESCAPES ${JSON.stringify(m.escapes)}` : '') +
        (m.wide.length ? ` wide:[${m.wide.join('; ')}]` : ''),
    );
    await p.close();
  }
}
await b.close();
process.exit(failures ? 1 : 0);
