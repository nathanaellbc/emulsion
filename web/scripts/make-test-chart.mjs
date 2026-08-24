/**
 * Generates a synthetic test chart for verifying the chain by eye.
 *
 * It carries the things the pipeline is supposed to be judged on: a 21-step
 * wedge to read the transfer, memory colours to judge the print stock, a
 * saturated primary row to see the crosstalk work, and a specular highlight
 * several stops above white so halation has something to scatter from.
 *
 *   node scripts/make-test-chart.mjs [out.png]
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = Number(process.env.CHART_W ?? 1200);
const H = 800;

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const oetf = (v) => {
  const x = Math.min(Math.max(v, 0), 1);
  return Math.round(255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
};

const px = Buffer.alloc(W * H * 3);
const put = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = oetf(r);
  px[i + 1] = oetf(g);
  px[i + 2] = oetf(b);
};

// Ground: a middle grey so the anchor has something honest to measure.
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 0.18, 0.18, 0.18);

// A 21-step wedge across the top, half a stop per step from -5 to +5.
for (let s = 0; s < 21; s++) {
  const v = 0.18 * Math.pow(2, (s - 10) * 0.5);
  const x0 = 40 + s * 53;
  for (let y = 40; y < 170; y++) for (let x = x0; x < x0 + 50; x++) put(x, y, v, v, v);
}

// Memory colours, scaled so each sits at a plausible reflectance.
const patches = [
  [0.44, 0.29, 0.22], // light skin
  [0.24, 0.15, 0.11], // darker skin
  [0.11, 0.2, 0.34], // sky
  [0.11, 0.24, 0.09], // foliage
  [0.35, 0.32, 0.28], // warm neutral
  [0.18, 0.18, 0.18], // mid grey
];
patches.forEach((c, i) => {
  const x0 = 40 + i * 186;
  for (let y = 210; y < 360; y++) for (let x = x0; x < x0 + 172; x++) put(x, y, c[0], c[1], c[2]);
});

// Saturated primaries and secondaries: what the crosstalk matrix acts on.
const prim = [
  [0.62, 0.03, 0.03],
  [0.03, 0.52, 0.05],
  [0.04, 0.07, 0.6],
  [0.62, 0.5, 0.03],
  [0.05, 0.48, 0.5],
  [0.55, 0.05, 0.5],
];
prim.forEach((c, i) => {
  const x0 = 40 + i * 186;
  for (let y = 380; y < 470; y++) for (let x = x0; x < x0 + 172; x++) put(x, y, c[0], c[1], c[2]);
});

// A continuous horizontal ramp over ten stops, to see banding or stair-stepping.
for (let x = 40; x < 1160; x++) {
  const v = 0.18 * Math.pow(2, ((x - 40) / 1120) * 10 - 5);
  for (let y = 490; y < 560; y++) put(x, y, v, v, v);
}

// Specular highlights, several stops past white. This is what halation needs:
// a source term that clears the threshold by a long way, against a dark ground.
for (let y = 580; y < 780; y++) for (let x = 40; x < 1160; x++) put(x, y, 0.02, 0.02, 0.02);
const lamps = [
  [220, 680, 26, 40],
  [480, 680, 16, 90],
  [740, 680, 9, 180],
  [1000, 680, 4, 400],
];
for (const [cx, cy, r, peak] of lamps) {
  for (let y = cy - r * 3; y <= cy + r * 3; y++) {
    for (let x = cx - r * 3; x <= cx + r * 3; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r * 3) continue;
      // A hard core with a small falloff, the way a real specular reads.
      const v = d <= r ? peak : peak * Math.exp(-(d - r) / (r * 0.5));
      if (v > 0.02) put(x, y, v, v, v);
    }
  }
}

const out = process.argv[2] ?? 'public/test-chart.png';
writeFileSync(out, encodePng(W, H, px));
console.log(`wrote ${out} (${W}x${H})`);
