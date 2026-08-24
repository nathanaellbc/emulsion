/**
 * Proper quantitative test: a 16-bit TIFF base vs the camera's own film
 * simulations, measured in CIE ΔE2000.
 *
 * Unlike the AVIF path, the TIFF is decoded *here* — not by the browser's
 * 8-bit createImageBitmap — so the full 16-bit precision is preserved. The
 * samples are read straight from the (uncompressed) strip, the sRGB transfer
 * is inverted to linear scene-referred light, and the result is carried as
 * float through EMULSION's host chain (`evaluateSceneLinear`), which is the
 * same equation set the shaders render and the test suite verifies.
 *
 * References are the six Fuji DNGs (Eterna-CP 3513DI / Kodak Vision 2383 ×
 * D55/D60/D65), decoded to display sRGB through the app's own LibRaw.
 *
 * Comparison: per-pixel ΔE2000 in sRGB space after geometric-mean luminance
 * alignment. Reported per pair: mean, median, p95, share under 1 and under
 * 2.3 (one JND). Lower is closer.
 *
 *   node scripts/delta-e-tif.mjs [--url http://localhost:5173]
 *
 * Needs the Vite dev server (serves /node_modules for LibRaw, and /src for the
 * core chain modules). Writes sample-compare/deltae-tif.json.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:5173';

const SAMPLE = 'sample';
const OUT = 'sample-compare';
const TIF = join(SAMPLE, 'IMG_1907.TIF');
const GRID = 320;

const SIMS = [
  { fuji: 'Fujifilm Eterna-CP 3513DI D55.dng', printId: 'prt.3513', illum: 'D55', kelvin: 5500 },
  { fuji: 'Fujifilm Eterna-CP 3513DI D60.dng', printId: 'prt.3513', illum: 'D60', kelvin: 6000 },
  { fuji: 'Fujifilm Eterna-CP 3513DI D65.dng', printId: 'prt.3513', illum: 'D65', kelvin: 6500 },
  { fuji: 'Kodak Vision 2383 D55.dng', printId: 'prt.2383', illum: 'D55', kelvin: 5500 },
  { fuji: 'Kodak Vision 2383 D60.dng', printId: 'prt.2383', illum: 'D60', kelvin: 6000 },
  { fuji: 'Kodak Vision 2383 D65.dng', printId: 'prt.2383', illum: 'D65', kelvin: 6500 },
];

// Exposure-compensation sweep. With no separate gain alignment, this is the
// single photometric fit: it finds where EMULSION's tone placement matches the
// reference. Wide enough to see the true minimum, not just the sweep edge.
const EV_SWEEP = [-3, -2.5, -2, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 1];

const FUJI_SETTINGS = {
  outputBps: 8, outputColor: 1, gamm: [2.2, 4.5], noAutoBright: false,
  useCameraWb: true, userQual: 3, userFlip: -1,
};

mkdirSync(OUT, { recursive: true });
const problems = [];

// ------------------------------------------------------- TIF decode (Node) ----
// Reads the 16-bit RGB strip straight out of an uncompressed TIFF, inverts the
// sRGB transfer, and returns linear scene-referred float RGB, downsampled to
// GRID by area averaging (box filter). This is the part the browser's 8-bit
// path would have thrown away.
function decodeTifLinear(path, grid) {
  const buf = readFileSync(path);
  const u16 = (o) => buf.readUInt16LE(o);
  const u32 = (o) => buf.readUInt32LE(o);
  if (u16(0) !== 0x4949 || u16(2) !== 42) throw new Error('not a little-endian TIFF');
  const ifd = u32(4);
  const count = u16(ifd);
  let W = 0, H = 0, stripOff = 0, spp = 0, bps = 0, photo = 0, compression = 1;
  const bpsOffHolder = {};
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), num = u32(e + 4), val = u32(e + 8);
    if (tag === 256) W = val;
    else if (tag === 257) H = val;
    else if (tag === 259) compression = val & 0xffff;
    else if (tag === 262) photo = val & 0xffff;
    else if (tag === 273) stripOff = val;
    else if (tag === 277) spp = val & 0xffff;
    else if (tag === 258) bpsOffHolder.off = val; // offset to 3 shorts when count=3
  }
  if (compression !== 1) throw new Error(`compressed TIFF (compression=${compression}) not supported by this decoder`);
  if (photo !== 2) throw new Error(`photometric=${photo}, expected 2 (RGB)`);
  if (spp !== 3) throw new Error(`samplesPerPixel=${spp}, expected 3`);
  const bits = u16(bpsOffHolder.off);
  if (bits !== 16) throw new Error(`bitsPerSample=${bits}, expected 16`);

  // sRGB EOTF inverse, to linear light, on 16-bit samples.
  const eotf = (v) => { v /= 65535; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

  const scale = grid / Math.max(W, H);
  const gw = Math.max(1, Math.round(W * scale));
  const gh = Math.max(1, Math.round(H * scale));
  const out = new Float32Array(gw * gh * 3);
  const cnt = new Float32Array(gw * gh);
  const rowBytes = W * spp * 2;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.floor((y / H) * gh));
    const rowBase = stripOff + y * rowBytes;
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor((x / W) * gw));
      const si = rowBase + x * spp * 2;
      const o = (gy * gw + gx) * 3;
      out[o] += eotf(buf.readUInt16LE(si));
      out[o + 1] += eotf(buf.readUInt16LE(si + 2));
      out[o + 2] += eotf(buf.readUInt16LE(si + 4));
      if (x % spp === 0 || true) cnt[gy * gw + gx]++;
    }
  }
  for (let i = 0; i < gw * gh; i++) {
    const c = cnt[i] || 1;
    out[i * 3] /= c; out[i * 3 + 1] /= c; out[i * 3 + 2] /= c;
  }
  return { gw, gh, linear: Array.from(out) };
}

// ----------------------------------------------------------- ΔE2000 (Node) ----
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
  const Cb = (C1 + C2) / 2, Cb7 = Math.pow(Cb, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const rad = Math.PI / 180;
  const h = (a, b) => { const an = Math.atan2(b, a) / rad; return an < 0 ? an + 360 : an; };
  const h1p = C1p === 0 ? 0 : h(a1p, b1), h2p = C2p === 0 ? 0 : h(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { const d = h2p - h1p; dhp = Math.abs(d) <= 180 ? d : d > 180 ? d - 360 : d + 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = 0;
  if (C1p * C2p !== 0) hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : ((h1p + h2p + 360) / 2) % 360;
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

console.log('decoding 16-bit TIFF base (full precision)…');
const tif = decodeTifLinear(TIF, GRID);
console.log(`  ${tif.gw}x${tif.gh} linear scene-referred float`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: 'domcontentloaded' });

// For each stock: run the EMULSION host chain over the 16-bit grid in the page
// (core modules served from /src), decode the Fuji reference, return both.
const results = [];
for (const sim of SIMS) {
  const tag = `${sim.printId.replace('prt.', '')}-${sim.illum}`;
  const b64 = readFileSync(join(SAMPLE, sim.fuji)).toString('base64');
  const m = await page.evaluate(async ({ tif, sim, b64, FUJI_SETTINGS, GRID, evSweep }) => {
    const { resolve } = await import('/src/core/resolve.ts');
    const { defaultRecipe } = await import('/src/core/recipe.ts');
    const { evaluateSceneLinear, encodeDisplay } = await import('/src/core/chain.ts');
    const { default: LibRaw } = await import('/node_modules/libraw-wasm/dist/index.js');

    const { gw, gh, linear } = tif;
    const N = gw * gh;
    const baseRecipe = defaultRecipe();
    baseRecipe.printId = sim.printId;
    baseRecipe.capture.whiteBalanceTempK = sim.kelvin;
    baseRecipe.grain.amount = 0;
    baseRecipe.halation.intensity = 0;

    // Render at each sweep EV; Node picks the one that minimises ΔE.
    const renders = evSweep.map((ev) => {
      const recipe = JSON.parse(JSON.stringify(baseRecipe));
      recipe.capture.exposureCompensation = ev;
      const p = resolve(recipe, { renderWidthPx: gw, sourceSpace: 'srgb' });
      const emu = new Uint8Array(N * 3);
      for (let i = 0; i < N; i++) {
        const y = evaluateSceneLinear([linear[i * 3], linear[i * 3 + 1], linear[i * 3 + 2]], p);
        const s = encodeDisplay(y);
        emu[i * 3] = Math.round(Math.min(Math.max(s[0], 0), 1) * 255);
        emu[i * 3 + 1] = Math.round(Math.min(Math.max(s[1], 0), 1) * 255);
        emu[i * 3 + 2] = Math.round(Math.min(Math.max(s[2], 0), 1) * 255);
      }
      return Array.from(emu);
    });
    const emu = null;

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dec = new LibRaw();
    let fuji;
    try {
      await dec.open(bytes, FUJI_SETTINGS);
      const img = await dec.imageData();
      const { width, height, colors, bits, data } = img;
      const sc = bits === 16 ? 1 / 65535 : 1 / 255;
      const full = document.createElement('canvas');
      full.width = width; full.height = height;
      const fx = full.getContext('2d');
      const im = fx.createImageData(width, height);
      for (let i = 0, o = 0, s = 0; i < width * height; i++, o += 4, s += colors) {
        im.data[o] = (data[s] ?? 0) * sc * 255;
        im.data[o + 1] = (data[s + 1] ?? 0) * sc * 255;
        im.data[o + 2] = (data[s + 2] ?? 0) * sc * 255;
        im.data[o + 3] = 255;
      }
      fx.putImageData(im, 0, 0);
      const scale = GRID / Math.max(width, height);
      const w2 = Math.max(1, Math.round(width * scale));
      const h2 = Math.max(1, Math.round(height * scale));
      const tmp = document.createElement('canvas');
      tmp.width = w2; tmp.height = h2;
      const ctx = tmp.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(full, 0, 0, w2, h2);
      fuji = Array.from(ctx.getImageData(0, 0, w2, h2).data);
      return { renders, fuji, gw, gh, fw: w2, fh: h2 };
    } finally {
      dec.dispose();
    }
  }, { tif, sim, b64, FUJI_SETTINGS, GRID, evSweep: EV_SWEEP });

  // ΔE in Node over the overlap, for each sweep render; keep the best EV.
  const W = Math.min(m.gw, m.fw), H = Math.min(m.gh, m.fh);
  const NN = W * H;
  const lumArr = (p, i, step) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];

  const evalRender = (emu) => {
    // No gain alignment: the EV sweep IS the photometric fit. Compare EMULSION
    // against the reference exactly as decoded.
    const dEs = new Float32Array(NN);
    let sum = 0, u1 = 0, u23 = 0, dLsum = 0, dCsum = 0;
    const bands = { shadow: [0, 0], mid: [0, 0], high: [0, 0] };
    for (let px = 0; px < NN; px++) {
      const fr = m.fuji[px * 4], fg = m.fuji[px * 4 + 1], fb = m.fuji[px * 4 + 2];
      const l1 = toLab(emu[px * 3], emu[px * 3 + 1], emu[px * 3 + 2]);
      const l2 = toLab(fr, fg, fb);
      const d = dE00(l1, l2);
      dEs[px] = d; sum += d; if (d < 1) u1++; if (d < 2.3) u23++;
      dLsum += l1[0] - l2[0];
      dCsum += Math.hypot(l1[1], l1[2]) - Math.hypot(l2[1], l2[2]);
      const fy = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
      const band = fy < 64 ? bands.shadow : fy < 160 ? bands.mid : bands.high;
      band[0] += d; band[1]++;
    }
    const sorted = Array.from(dEs).sort((a, b) => a - b);
    const bm = (b) => (b[1] ? b[0] / b[1] : 0);
    return {
      mean: sum / NN, median: sorted[Math.floor(NN / 2)], p95: sorted[Math.floor(NN * 0.95)],
      pctUnder1: (100 * u1) / NN, pctUnder23: (100 * u23) / NN,
      deShadow: bm(bands.shadow), deMid: bm(bands.mid), deHigh: bm(bands.high),
      dL: dLsum / NN, dChroma: dCsum / NN,
    };
  };

  let best = null, bestEv = 0;
  m.renders.forEach((emu, k) => {
    const r = evalRender(emu);
    if (!best || r.mean < best.mean) { best = r; bestEv = EV_SWEEP[k]; }
  });
  const ev0 = evalRender(m.renders[EV_SWEEP.indexOf(0)]);

  const row = { tag, stock: sim.printId, illum: sim.illum, kelvin: sim.kelvin, bestEv, meanAtEv0: ev0.mean, ...best };
  results.push(row);
  console.log(`  ${tag.padEnd(12)}  best EV ${String(bestEv).padStart(5)}  mean ${best.mean.toFixed(2).padStart(5)} (was ${ev0.mean.toFixed(2)})  |  shadow ${best.deShadow.toFixed(1)}  mid ${best.deMid.toFixed(1)}  high ${best.deHigh.toFixed(1)}  |  dL ${best.dL.toFixed(1)}  dChr ${best.dChroma.toFixed(1)}`);
}

await browser.close();
writeFileSync(join(OUT, 'deltae-tif.json'), JSON.stringify(results, null, 2));
const meanOf = (k) => results.reduce((a, r) => a + r[k], 0) / results.length;
console.log(`\n  overall mean ΔE ${meanOf('mean').toFixed(2)} at best-fit exposure (was ${meanOf('meanAtEv0').toFixed(2)} at EV 0)`);
console.log(`  written: ${join(OUT, 'deltae-tif.json')}`);

if (problems.length) {
  console.error(`\n${problems.length} page problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
