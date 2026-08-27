/**
 * Renders the EMULSION home-screen icon set from an inline SVG design:
 * a film-frame mark — a rounded dark slab, one amber exposure cell lit,
 * three ghost cells beside it — the app's "one bright print in a dark
 * frame" idea at icon scale. iOS masks round corners itself; the safe
 * area is respected by keeping the mark inside ~62% of the canvas.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const SIZES = [
  { file: 'apple-touch-icon.png', px: 180 },
  { file: 'icon-192.png', px: 192 },
  { file: 'icon-512.png', px: 512 },
];

// One markup, sized by scale. The icon face is a warm near-black slab with a
// subtle top-left sheen (the UI's own panel lighting), a film-strip of four
// sprocket cells, and a single lit amber cell — the print in the dark.
const markup = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="face" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a191f"/>
      <stop offset="0.55" stop-color="#111116"/>
      <stop offset="1" stop-color="#0a0a0e"/>
    </linearGradient>
    <linearGradient id="cell" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f0a95c"/>
      <stop offset="1" stop-color="#c97a34"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#e8974a" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#e8974a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#face)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="110.5" fill="none"
        stroke="#ffffff" stroke-opacity="0.14" stroke-width="3"/>
  <circle cx="256" cy="230" r="150" fill="url(#glow)"/>
  <!-- the film strip -->
  <g>
    <rect x="96" y="150" width="320" height="160" rx="26" fill="#060608"
          stroke="#ffffff" stroke-opacity="0.1" stroke-width="3"/>
    <!-- sprocket holes, top and bottom -->
    <g fill="#ffffff" fill-opacity="0.16">
      <rect x="124" y="132" width="26" height="18" rx="6"/>
      <rect x="174" y="132" width="26" height="18" rx="6"/>
      <rect x="224" y="132" width="26" height="18" rx="6"/>
      <rect x="274" y="132" width="26" height="18" rx="6"/>
      <rect x="324" y="132" width="26" height="18" rx="6"/>
      <rect x="374" y="132" width="26" height="18" rx="6"/>
      <rect x="124" y="310" width="26" height="18" rx="6"/>
      <rect x="174" y="310" width="26" height="18" rx="6"/>
      <rect x="224" y="310" width="26" height="18" rx="6"/>
      <rect x="274" y="310" width="26" height="18" rx="6"/>
      <rect x="324" y="310" width="26" height="18" rx="6"/>
      <rect x="374" y="310" width="26" height="18" rx="6"/>
    </g>
    <!-- three ghost frames, one lit -->
    <rect x="122" y="174" width="60" height="112" rx="10" fill="#ffffff" fill-opacity="0.08"/>
    <rect x="198" y="174" width="60" height="112" rx="10" fill="#ffffff" fill-opacity="0.08"/>
    <rect x="274" y="174" width="118" height="112" rx="10" fill="url(#cell)"/>
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
