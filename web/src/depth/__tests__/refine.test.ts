import { describe, expect, it } from 'vitest';
import {
  jointBilateralUpsample,
  modelInputSize,
  normaliseDisparity,
  resampleRGB,
  sampleDisparity,
  toModelTensor,
} from '../refine';

describe('the model input, as depth_anything_v2 prepares it', () => {
  it('puts the short side on 518 and both sides on a multiple of 14', () => {
    // The Space's demo images come out 784 × 518, exactly as PyTorch sizes them.
    expect(modelInputSize(1500, 1000)).toEqual([784, 518]);
    expect(modelInputSize(4032, 3024)).toEqual([686, 518]);
    expect(modelInputSize(3024, 4032)).toEqual([518, 686]);
    expect(modelInputSize(300, 300)).toEqual([518, 518]);
  });

  it('normalises with the ImageNet mean and deviation, channels first', () => {
    const t = toModelTensor(new Float32Array([0.485, 0.456, 0.406, 1, 1, 1]), 2, 1);
    // Plane R holds both pixels' red, then plane G, then plane B.
    expect(t[0]).toBeCloseTo(0, 6);
    expect(t[1]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(t[2]).toBeCloseTo(0, 6);
    expect(t[4]).toBeCloseTo(0, 6);
  });

  it('resamples a flat field to the same flat field', () => {
    const src = new Uint8ClampedArray(37 * 23 * 4).fill(128);
    const out = resampleRGB(src, 37, 23, 11, 7);
    for (const v of out) expect(v).toBeCloseTo(128 / 255, 5);
  });
});

describe('joint bilateral upsampling', () => {
  // A guide with a hard vertical edge at x = 40 of 100, and a low-res
  // disparity whose edge the network could only place to within a pixel of 10.
  const hw = 100;
  const hh = 4;
  const lw = 10;
  const lh = 2;
  const guide = new Uint8ClampedArray(hw * hh * 4);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      const v = x < 40 ? 20 : 230;
      guide.set([v, v, v, 255], (y * hw + x) * 4);
    }
  const low = new Float32Array(lw * lh);
  const lowGuide = new Float32Array(lw * lh * 3);
  for (let y = 0; y < lh; y++)
    for (let x = 0; x < lw; x++) {
      const near = x < 4; // the subject: dark, and near
      low[y * lw + x] = near ? 1 : 0;
      lowGuide.fill(near ? 20 / 255 : 230 / 255, (y * lw + x) * 3, (y * lw + x) * 3 + 3);
    }

  it('puts the depth edge where the picture’s edge is', () => {
    const up = jointBilateralUpsample(low, lw, lh, lowGuide, guide, hw, hh);
    // Two pixels either side of the true edge, the disparity has already
    // committed — a bilinear upsample would still be half-way there.
    expect(up[37]!).toBeGreaterThan(0.95);
    expect(up[42]!).toBeLessThan(0.05);
  });

  it('leaves a flat map flat', () => {
    const flat = new Float32Array(lw * lh).fill(0.42);
    const up = jointBilateralUpsample(flat, lw, lh, lowGuide, guide, hw, hh);
    for (const v of up) expect(v).toBeCloseTo(0.42, 6);
  });
});

describe('disparity normalisation and sampling', () => {
  it('maps the far percentile to 0 and the near one to 1', () => {
    const d = new Float32Array(10000);
    for (let i = 0; i < d.length; i++) d[i] = 3 + (7 * i) / d.length;
    const n = normaliseDisparity(d);
    expect(n[0]).toBe(0);
    expect(n[n.length - 1]!).toBeGreaterThan(0.99);
    expect(n[5000]!).toBeCloseTo(0.5, 1);
  });

  it('reads a focus tap as the median of its window, not a blend across an edge', () => {
    const w = 20;
    const h = 20;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < 11 ? 0.8 : 0.1;
    // Centred one pixel inside the subject: most of the window is subject.
    expect(sampleDisparity(data, w, h, 9 / 19, 0.5)).toBe(Math.fround(0.8));
  });
});
