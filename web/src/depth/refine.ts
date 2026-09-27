/**
 * The numerical half of depth estimation — everything except the network —
 * kept free of workers and GPUs so it can be tested on the host.
 *
 *   guide (sRGB, ≤ 1536 px) -> resample to the model's input -> normalise
 *   -> [network] -> joint bilateral upsample back to the guide -> normalise
 *
 * The network sees a 518-pixel picture and answers at that resolution, so its
 * edges are 518-pixel edges. Upsampled bilinearly they would smear a
 * foreground's disparity a pixel or three into the background at the guide's
 * scale, and the gather would then blur a rim of background sharp — or a rim
 * of the subject soft. Joint bilateral upsampling (Kopf et al. 2007) lets the
 * full-resolution picture decide where each edge actually falls: a low-res
 * disparity sample is trusted at a pixel in proportion to how alike the two
 * pixels' colours are. Hair and glass stay hard cases, as §XIII says they are;
 * the silhouettes of solid objects come back crisp.
 */

import { DEPTH_MODEL } from './model';

/** `Resize(lower_bound, ensure_multiple_of=14)` from depth_anything_v2/util/transform.py. */
export function modelInputSize(width: number, height: number): [number, number] {
  const { inputSize: s, multipleOf: m } = DEPTH_MODEL;
  // Lower bound: scale so the *shorter* side lands on the target.
  const scale = Math.max(s / width, s / height);
  const constrain = (x: number) => {
    let y = Math.round(x / m) * m;
    if (y < s) y = Math.ceil(x / m) * m;
    return y;
  };
  return [constrain(scale * width), constrain(scale * height)];
}

/** Keys' cubic, a = −0.75 — the kernel cv2.INTER_CUBIC uses. */
function cubic(x: number): number {
  const a = -0.75;
  const t = Math.abs(x);
  if (t < 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
  if (t < 2) return (((t - 5) * t + 8) * t - 4) * a;
  return 0;
}

/** One axis of a separable resample: per output sample, source taps and weights. */
function taps(src: number, dst: number): { start: Int32Array; count: number; weights: Float32Array } {
  const scale = src / dst;
  // Downscaling widens the kernel so every source pixel is seen (antialiasing);
  // upscaling keeps it at the cubic's own support.
  const stretch = Math.max(scale, 1);
  const count = Math.ceil(2 * stretch) * 2 + 1;
  const start = new Int32Array(dst);
  const weights = new Float32Array(dst * count);
  for (let i = 0; i < dst; i++) {
    const centre = (i + 0.5) * scale - 0.5;
    const first = Math.floor(centre - 2 * stretch) + 1;
    start[i] = first;
    let sum = 0;
    for (let k = 0; k < count; k++) {
      const w = cubic((first + k - centre) / stretch);
      weights[i * count + k] = w;
      sum += w;
    }
    for (let k = 0; k < count; k++) weights[i * count + k]! /= sum || 1;
  }
  return { start, count, weights };
}

/**
 * RGBA8 to float RGB at a new size, separable cubic, 0–1. Clamped at the
 * edges; the negative lobes can overshoot, which is clamped too.
 */
export function resampleRGB(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const hx = taps(sw, dw);
  const hy = taps(sh, dh);
  const tmp = new Float32Array(dw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      const s0 = hx.start[x]!;
      for (let k = 0; k < hx.count; k++) {
        const sx = Math.min(Math.max(s0 + k, 0), sw - 1);
        const w = hx.weights[x * hx.count + k]!;
        const i = (y * sw + sx) * 4;
        r += src[i]! * w;
        g += src[i + 1]! * w;
        b += src[i + 2]! * w;
      }
      const o = (y * dw + x) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  const out = new Float32Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const s0 = hy.start[y]!;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < hy.count; k++) {
        const sy = Math.min(Math.max(s0 + k, 0), sh - 1);
        const w = hy.weights[y * hy.count + k]!;
        const i = (sy * dw + x) * 3;
        r += tmp[i]! * w;
        g += tmp[i + 1]! * w;
        b += tmp[i + 2]! * w;
      }
      const o = (y * dw + x) * 3;
      out[o] = Math.min(Math.max(r / 255, 0), 1);
      out[o + 1] = Math.min(Math.max(g / 255, 0), 1);
      out[o + 2] = Math.min(Math.max(b / 255, 0), 1);
    }
  }
  return out;
}

/** `NormalizeImage` + `PrepareForNet`: ImageNet mean/std, HWC to CHW. */
export function toModelTensor(rgb: Float32Array, w: number, h: number): Float32Array {
  const { mean, std } = DEPTH_MODEL;
  const plane = w * h;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    out[i] = (rgb[i * 3]! - mean[0]) / std[0];
    out[plane + i] = (rgb[i * 3 + 1]! - mean[1]) / std[1];
    out[2 * plane + i] = (rgb[i * 3 + 2]! - mean[2]) / std[2];
  }
  return out;
}

/**
 * Joint bilateral upsample of the network's disparity (`low`, lw × lh, with
 * `lowGuide` the RGB the network actually saw) onto the guide picture
 * (`hiGuide`, RGBA8, hw × hh). Sampling positions follow the reference's
 * `F.interpolate(..., align_corners=True)`.
 */
export function jointBilateralUpsample(
  low: Float32Array,
  lw: number,
  lh: number,
  lowGuide: Float32Array,
  hiGuide: Uint8ClampedArray,
  hw: number,
  hh: number,
  sigmaSpatial = 0.9,
  sigmaRange = 0.1,
): Float32Array {
  const out = new Float32Array(hw * hh);
  const sx = hw > 1 ? (lw - 1) / (hw - 1) : 0;
  const sy = hh > 1 ? (lh - 1) / (hh - 1) : 0;
  const invS = 1 / (2 * sigmaSpatial * sigmaSpatial);
  const invR = 1 / (2 * sigmaRange * sigmaRange);
  for (let y = 0; y < hh; y++) {
    const v = y * sy;
    const j0 = Math.floor(v);
    for (let x = 0; x < hw; x++) {
      const u = x * sx;
      const i0 = Math.floor(u);
      const p = (y * hw + x) * 4;
      const gr = hiGuide[p]! / 255;
      const gg = hiGuide[p + 1]! / 255;
      const gb = hiGuide[p + 2]! / 255;
      let sum = 0;
      let wsum = 0;
      // The bilinear answer, kept in case every range weight underflows (a
      // pixel unlike anything the network saw nearby).
      let bl = 0;
      let blw = 0;
      for (let j = j0 - 1; j <= j0 + 2; j++) {
        if (j < 0 || j >= lh) continue;
        const dy = v - j;
        for (let i = i0 - 1; i <= i0 + 2; i++) {
          if (i < 0 || i >= lw) continue;
          const dx = u - i;
          const q = j * lw + i;
          const ws = Math.exp(-(dx * dx + dy * dy) * invS);
          const dr = gr - lowGuide[q * 3]!;
          const dg = gg - lowGuide[q * 3 + 1]!;
          const db = gb - lowGuide[q * 3 + 2]!;
          const w = ws * Math.exp(-(dr * dr + dg * dg + db * db) * invR);
          sum += low[q]! * w;
          wsum += w;
          const wb = Math.max(0, 1 - Math.abs(dx)) * Math.max(0, 1 - Math.abs(dy));
          bl += low[q]! * wb;
          blw += wb;
        }
      }
      out[y * hw + x] = wsum > 1e-6 ? sum / wsum : bl / Math.max(blw, 1e-6);
    }
  }
  return out;
}

/**
 * Relative disparity to the 0-at-infinity scale `core/defocus.ts` expects.
 * The far anchor is the 0.5th percentile, not the minimum, so a handful of
 * noisy sky pixels cannot set it; the scale is the 99.5th, so the nearest
 * speck of dust cannot either. Nearer than that keeps its own value (up to
 * 1.5) — clamping it would put the nearest object into a single plane.
 */
export function normaliseDisparity(d: Float32Array): Float32Array {
  const step = Math.max(1, Math.floor(d.length / 65536));
  const sample: number[] = [];
  for (let i = 0; i < d.length; i += step) sample.push(d[i]!);
  sample.sort((a, b) => a - b);
  const q = (p: number) => sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))]!;
  const lo = q(0.005);
  const hi = q(0.995);
  const span = Math.max(hi - lo, 1e-6);
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = Math.min(Math.max((d[i]! - lo) / span, 0), 1.5);
  return out;
}

/**
 * Normalised disparity at a point, as the median of a small window: a focus
 * tap that lands on an edge takes the side most of the window is on, instead
 * of an average of subject and background that belongs to neither.
 * `(u, v)` are in the map's own row order, 0–1.
 */
export function sampleDisparity(
  data: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number,
  radius = 3,
): number {
  const cx = Math.min(Math.max(Math.round(u * (width - 1)), 0), width - 1);
  const cy = Math.min(Math.max(Math.round(v * (height - 1)), 0), height - 1);
  const values: number[] = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || x >= width) continue;
      values.push(data[y * width + x]!);
    }
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}
