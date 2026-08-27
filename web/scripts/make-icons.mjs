/**
 * Renders the EMULSION home-screen icon set from an inline SVG design:
 * a monochrome mark — two polished-silver film strips interlocked like
 * chain links around the app's dark center, sprocket holes punched
 * along their outer edges and snipped film ends facing outward. iOS
 * masks round corners itself; the safe area is respected by keeping
 * the mark inside ~62% of the canvas.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const SIZES = [
  { file: 'apple-touch-icon.png', px: 180 },
  { file: 'icon-192.png', px: 192 },
  { file: 'icon-512.png', px: 512 },
];

// One markup, sized by scale. The icon face is a near-black slab with a
// subtle top-left lift, carrying two silver film strips linked like chain:
// the right strip is drawn first, the left over it at the top crossing,
// then a clipped re-draw of the right strip's lower corner puts it back on
// top at the bottom crossing — a proper over-under weave.

// Left strip: vertical bar with a 35° snipped top-right end, sprocket
// holes along its left edge, and a bottom sweep that reaches under the
// right strip. The right strip is this same geometry rotated 180°.
const STRIP_PATH =
  'M 170 118 L 180 118 L 235 158 L 235 336 L 282 336 A 26 26 0 0 1 308 362 ' +
  'L 308 368 A 26 26 0 0 1 282 394 L 235 394 L 235 374 A 28 28 0 0 1 207 402 ' +
  'L 178 402 A 28 28 0 0 1 150 374 L 150 138 A 20 20 0 0 1 170 118 Z';
const HOLES = [
  { x: 163, y: 170 },
  { x: 163, y: 255 },
  { x: 163, y: 340 },
]
  .map((h) => `<rect x="${h.x}" y="${h.y}" width="28" height="34" rx="9"/>`)
  .join('\n      ');
const strip = (holes) => `<path d="${STRIP_PATH}"/>
      <g fill="#0d0d10">${holes ? `\n      ${HOLES}\n      ` : ''}</g>`;

const markup = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="lift" cx="0" cy="0" r="1">
      <stop offset="0" stop-color="#1a1a1f"/>
      <stop offset="1" stop-color="#0b0b0e"/>
    </radialGradient>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f5f5f6"/>
      <stop offset="1" stop-color="#bdbdc2"/>
    </linearGradient>
    <clipPath id="under"><rect x="246" y="314" width="138" height="94"/></clipPath>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#lift)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="113.5" fill="none"
        stroke="#ffffff" stroke-opacity="0.10" stroke-width="3"/>
  <!-- right strip (under): holes on its right edge, snipped bottom-left end -->
  <g fill="url(#silver)" transform="rotate(180 256 256)">
    ${strip(true)}
  </g>
  <!-- left strip (over at the top): holes on its left edge, snipped top-right end -->
  <g fill="url(#silver)">
    ${strip(true)}
  </g>
  <!-- re-lay the right strip's lower reach so the bottom crossing reads under/over -->
  <g fill="url(#silver)" transform="rotate(180 256 256)" clip-path="url(#under)">
    ${strip(false)}
  </g>
</svg>`;

mkdirSync('public/icons', { recursive: true });
const b = await chromium.launch();
const page = await b.newPage();
for (const { file, px } of SIZES) {
  await page.setContent(
    `<body style="margin:0"><div style="width:${px}px;height:${px}px">${markup(px)}</div></body>`,
  );
  await page.locator('svg').screenshot({ path: `public/icons/${file}` });
  console.log(`public/icons/${file} (${px}px)`);
}
await b.close();
