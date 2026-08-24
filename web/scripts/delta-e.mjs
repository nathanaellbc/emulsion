/**
 * Quantitative accuracy: EMULSION render vs the camera's own film simulation,
 * measured in CIE ΔE2000.
 *
 * `sample/` holds one base photograph (the AVIF) and the same scene rendered by
 * the camera through two print-stock simulations (Eterna-CP 3513DI, Kodak
 * Vision 2383) balanced for D55/D60/D65. Two phases:
 *
 *   1. decode each Fuji DNG to display sRGB (standard output intent: 2.2 gamma,
 *      auto-bright, camera WB) through the app's own LibRaw, downsampled to a
 *      comparison grid — done in a lightweight page, independent of the app;
 *   2. render the base through EMULSION with the matching print stock and white
 *      balance (grain and halation at zero — the pointwise transfer a
 *      print-stock simulation is), and read the display-encoded pixels.
 *
 * Comparison (in Node): per-pixel ΔE2000 in sRGB space, after removing the
 * residual exposure gap by aligning geometric-mean luminance — the honest
 * photometric anchor, §V's g_cal made a measurement. Reported per pair: mean,
 * median, p95, and the share of pixels under 1 and under 2.3 (one JND). Lower
 * is closer; a mean under ~2 is generally considered a match.
 *
 *   node scripts/delta-e.mjs [--url http://localhost:5173]
 *
 * Needs the Vite dev server (it serves /node_modules, which the Fuji decode
 * imports LibRaw from). Writes sample-compare/deltae.json and prints a table.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:5173';

const SAMPLE = 'sample';
const OUT = 'sample-compare';
const BASE = join(SAMPLE, 'IMG_1906.AVIF');
const GRID = 320; // common comparison grid (long edge), plenty for ΔE statistics

const SIMS = [
  { fuji: 'Fujifilm Eterna-CP 3513DI D55.dng', printId: 'prt.3513', illum: 'D55', kelvin: 5500 },
  { fuji: 'Fujifilm Eterna-CP 3513DI D60.dng', printId: 'prt.3513', illum: 'D60', kelvin: 6000 },
  { fuji: 'Fujifilm Eterna-CP 3513DI D65.dng', printId: 'prt.3513', illum: 'D65', kelvin: 6500 },
  { fuji: 'Kodak Vision 2383 D55.dng', printId: 'prt.2383', illum: 'D55', kelvin: 5500 },
  { fuji: 'Kodak Vision 2383 D60.dng', printId: 'prt.2383', illum: 'D60', kelvin: 6000 },
  { fuji: 'Kodak Vision 2383 D65.dng', printId: 'prt.2383', illum: 'D65', kelvin: 6500 },
];

const FUJI_SETTINGS = {
  outputBps: 8, outputColor: 1, gamm: [2.2, 4.5], noAutoBright: false,
  useCameraWb: true, userQual: 3, userFlip: -1,
};

mkdirSync(OUT, { recursive: true });
const problems = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// ---------------------------------------------------------------- phase 1 ----
// Decode the six Fuji DNGs in a blank page (LibRaw from the dev server's
// /node_modules). Independent of the app, so a slow decode never stalls it.
console.log('decoding Fuji references…');
const fujiRef = {};
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`fuji pageerror: ${e.message}`));
  await page.goto(`${url.replace(/\/$/, '')}/favicon.ico`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  for (const sim of SIMS) {
    const tag = `${sim.printId.replace('prt.', '')}-${sim.illum}`;
    const b64 = readFileSync(join(SAMPLE, sim.fuji)).toString('base64');
    fujiRef[tag] = await page.evaluate(async ({ b64, settings, GRID }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const { default: LibRaw } = await import('/node_modules/libraw-wasm/dist/index.js');
      const dec = new LibRaw();
      try {
        await dec.open(bytes, settings);
        const img = await dec.imageData();
        if (!img) throw new Error('no image data');
        const { width, height, colors, bits, data } = img;
        const scale = bits === 16 ? 1 / 65535 : 1 / 255;
        const full = document.createElement('canvas');
        full.width = width; full.height = height;
        const fctx = full.getContext('2d');
        const im = fctx.createImageData(width, height);
        for (let i = 0, o = 0, s = 0; i < width * height; i++, o += 4, s += colors) {
          im.data[o] = (data[s] ?? 0) * scale * 255;
          im.data[o + 1] = (data[s + 1] ?? 0) * scale * 255;
          im.data[o + 2] = (data[s + 2] ?? 0) * scale * 255;
          im.data[o + 3] = 255;
        }
        fctx.putImageData(im, 0, 0);
        const sc = GRID / Math.max(width, height);
        const gw = Math.max(1, Math.round(width * sc));
        const gh = Math.max(1, Math.round(height * sc));
        const tmp = document.createElement('canvas');
        tmp.width = gw; tmp.height = gh;
        const ctx = tmp.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(full, 0, 0, gw, gh);
        const px = ctx.getImageData(0, 0, gw, gh).data;
        return { gw, gh, pixels: Array.from(px) };
      } finally {
        dec.dispose();
      }
    }, { b64, settings: FUJI_SETTINGS, GRID });
    console.log(`  ${tag}: ${fujiRef[tag].gw}x${fujiRef[tag].gh}`);
  }
  await page.close();
}

// ---------------------------------------------------------------- phase 2 ----
// Render the base through EMULSION for each stock + illuminant.
console.log('rendering through EMULSION…');
const emuRender = {};
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
  page.on('pageerror', (e) => problems.push(`emu pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`emu console: ${m.text()}`); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dropzone');
  await page.setInputFiles('input[type=file]', BASE);
  await page.waitForSelector('.rail', { timeout: 30000 });
  await page.waitForTimeout(1200);

  const setSlider = async (label, value) => {
    const input = page.locator('.control', { has: page.locator(`label:text-is("${label}")`) }).locator('input');
    await input.evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  await setSlider('Amount', 0);
  await setSlider('Intensity', 0);
  await setSlider('Exposure compensation', 0);

  const readPixels = () => page.evaluate((GRID) => {
    const c = document.querySelector('canvas');
    const scale = GRID / Math.max(c.width, c.height);
    const gw = Math.max(1, Math.round(c.width * scale));
    const gh = Math.max(1, Math.round(c.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = gw; tmp.height = gh;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(c, 0, 0, gw, gh);
    return { gw, gh, pixels: Array.from(ctx.getImageData(0, 0, gw, gh).data) };
  }, GRID);

  for (const sim of SIMS) {
    const tag = `${sim.printId.replace('prt.', '')}-${sim.illum}`;
    await page.getByLabel('Print stock').selectOption(sim.printId);
    await setSlider('White balance', sim.kelvin);
    await page.waitForTimeout(900);
    emuRender[tag] = await readPixels();
    console.log(`  ${tag}: ${emuRender[tag].gw}x${emuRender[tag].gh}`);
  }
  await page.close();
}
await browser.close();

// ------------------------------------------------------------- comparison ----
// ΔE2000 in sRGB space, after geometric-mean luminance alignment.
function toLab(r, g, b) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function dE00(l1, l2) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Math.pow(Cb, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const rad = Math.PI / 180;
  const h = (a, b) => { const an = Math.atan2(b, a) / rad; return an < 0 ? an + 360 : an; };
  const h1p = C1p === 0 ? 0 : h(a1p, b1);
  const h2p = C2p === 0 ? 0 : h(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    const d = h2p - h1p;
    dhp = Math.abs(d) <= 180 ? d : d > 180 ? d - 360 : d + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = 0;
  if (C1p * C2p !== 0) {
    hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : ((h1p + h2p + 360) / 2) % 360;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2)
    + Rt * (dCp / Sc) * (dHp / Sh));
}

function compare(emu, fuji) {
  const W = Math.min(emu.gw, fuji.gw);
  const H = Math.min(emu.gh, fuji.gh);
  const N = W * H;
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  let eSum = 0, fSum = 0;
  for (let i = 0; i < N * 4; i += 4) { eSum += Math.log(lum(emu.pixels, i) + 1e-3); fSum += Math.log(lum(fuji.pixels, i) + 1e-3); }
  const gain = Math.exp((eSum - fSum) / N);

  const dEs = new Float32Array(N);
  let sum = 0, under1 = 0, under23 = 0;
  for (let px = 0; px < N; px++) {
    const i = px * 4;
    const l1 = toLab(emu.pixels[i], emu.pixels[i + 1], emu.pixels[i + 2]);
    const l2 = toLab(
      Math.min(255, fuji.pixels[i] * gain),
      Math.min(255, fuji.pixels[i + 1] * gain),
      Math.min(255, fuji.pixels[i + 2] * gain),
    );
    const d = dE00(l1, l2);
    dEs[px] = d; sum += d;
    if (d < 1) under1++; if (d < 2.3) under23++;
  }
  const sorted = Array.from(dEs).sort((a, b) => a - b);

  // Channel + luminance means, so a comparison mismatch is diagnosable.
  const meanRGB = (p) => {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < N * 4; i += 4) { r += p[i]; g += p[i + 1]; b += p[i + 2]; }
    return [r / N, g / N, b / N].map((v) => Math.round(v));
  };
  return {
    gain, mean: sum / N, median: sorted[Math.floor(N / 2)], p95: sorted[Math.floor(N * 0.95)],
    pctUnder1: (100 * under1) / N, pctUnder23: (100 * under23) / N, grid: [W, H],
    emuRGB: meanRGB(emu.pixels), fujiRGB: meanRGB(fuji.pixels),
  };
}

console.log('\nEMULSION vs camera simulation (ΔE2000, sRGB, luminance-aligned):');
const results = [];
for (const sim of SIMS) {
  const tag = `${sim.printId.replace('prt.', '')}-${sim.illum}`;
  const m = compare(emuRender[tag], fujiRef[tag]);

  // Luminance correlation between the two grids: 1.0 = same framing/structure.
  // Search a small translation window: if a shift recovers correlation, the two
  // are the same frame misaligned; if nothing helps, they are genuinely different.
  const align = (() => {
    const W = m.grid[0], H = m.grid[1];
    const a = emuRender[tag].pixels, b = fujiRef[tag].pixels;
    const lum = (p, x, y) => { const i = (y * W + x) * 4; return 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]; };
    const corrAt = (dx, dy) => {
      const A = [], B = [];
      for (let y = 12; y < H - 12; y++) for (let x = 12; x < W - 12; x++) {
        A.push(lum(a, x, y)); B.push(lum(b, x + dx, y + dy));
      }
      const mean = (v) => v.reduce((s, t) => s + t, 0) / v.length;
      const ma = mean(A), mb = mean(B);
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < A.length; i++) { const q = A[i] - ma, r = B[i] - mb; num += q * r; da += q * q; db += r * r; }
      return num / Math.sqrt(da * db);
    };
    let best = { dx: 0, dy: 0, s: 1, c: corrAt(0, 0) };
    for (const s of [0.92, 0.96, 1, 1.04, 1.08]) {
      // Resample b by scale s about the centre, then correlate (dx=dy=0).
      const A = [], B = [];
      for (let y = 12; y < H - 12; y++) for (let x = 12; x < W - 12; x++) {
        const bx = Math.round(W / 2 + (x - W / 2) / s);
        const by = Math.round(H / 2 + (y - H / 2) / s);
        if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
        A.push(lum(a, x, y)); B.push(lum(b, bx, by));
      }
      const mean = (v) => v.reduce((s2, t) => s2 + t, 0) / v.length;
      const ma = mean(A), mb = mean(B);
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < A.length; i++) { const q = A[i] - ma, r = B[i] - mb; num += q * r; da += q * q; db += r * r; }
      const c = num / Math.sqrt(da * db);
      if (c > best.c) best = { dx: 0, dy: 0, s, c };
    }
    return { at0: corrAt(0, 0), best };
  })();
  m.lumCorr = align.at0;
  m.alignBest = align.best;
  results.push({ tag, stock: sim.printId, illum: sim.illum, kelvin: sim.kelvin, ...m });
  console.log(`  ${tag.padEnd(12)}  mean ${m.mean.toFixed(2).padStart(5)}  corr@0 ${m.lumCorr.toFixed(3)}  best ${m.alignBest.c.toFixed(3)} @ scale ${m.alignBest.s}  (gain ${m.gain.toFixed(2)})`);
}
writeFileSync(join(OUT, 'deltae.json'), JSON.stringify(results, null, 2));

const meanOf = (k) => results.reduce((a, r) => a + r[k], 0) / results.length;
console.log(`\n  overall mean ΔE ${meanOf('mean').toFixed(2)} across ${results.length} stock/illuminant pairs`);
console.log(`  written: ${join(OUT, 'deltae.json')}`);

if (problems.length) {
  console.error(`\n${problems.length} page problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
