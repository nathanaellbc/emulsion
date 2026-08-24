/**
 * Fitting the pyramid weights to the stock's point spread function.
 *
 * §XII models diffuse halation as a normalised isotropic exponential, plus an
 * optional annulus from the light that reflects off the back of the base. An
 * exponential is not a Gaussian — it has a far heavier tail, which is exactly
 * why film halos reach so much further than a blur does — so the render
 * approximates it as a weighted sum of the pyramid's Gaussians, with the
 * weights solved here rather than guessed.
 */

import type { Triple } from '../core/triple';

export const PYRAMID_LEVELS = 7;
/** Blur applied at each level, in that level's own texels. */
export const LEVEL_SIGMA = 2.0;

/**
 * Full-resolution sigma of each pyramid level, in pixels.
 *
 * Each level is the previous level blurred and halved, so the blur it inherits
 * adds in quadrature to the one applied at its own scale. Ignoring the
 * inherited term would make the fit below solve against widths the pyramid
 * does not actually produce.
 */
export function levelSigmas(): number[] {
  const out: number[] = [];
  let sigma = 0;
  for (let j = 0; j < PYRAMID_LEVELS; j++) {
    const applied = LEVEL_SIGMA * Math.pow(2, j);
    sigma = Math.sqrt(sigma * sigma + applied * applied);
    out.push(sigma);
  }
  return out;
}

/**
 * Radius of the base-reflection ring. Light leaves the emulsion, crosses the
 * base at the critical angle for n = 1.5, reflects and returns:
 * r = 2 t_b tan(theta_c). With t_b = 125 um that is ~224 um at the film plane.
 */
export const BASE_THICKNESS_UM = 125;
export const RING_RADIUS_UM = 2 * BASE_THICKNESS_UM * Math.tan((41.8 * Math.PI) / 180);

interface FitOptions {
  /** Scattering length in pixels. */
  lengthPx: number;
  /** Base-reflection weight. */
  omega: number;
  /** Ring radius in pixels. */
  ringRadiusPx: number;
}

/** Target radial PSF: (1-omega) exponential + omega annulus, each unit-energy. */
function targetPsf(r: number, o: FitOptions): number {
  const l = Math.max(o.lengthPx, 1e-3);
  const diffuse = Math.exp(-r / l) / (2 * Math.PI * l * l);
  if (o.omega <= 1e-6) return diffuse;
  const rMin = Math.max(o.ringRadiusPx, 1e-3);
  const w = 0.35 * rMin;
  // Normaliser for the annulus under the 2 pi r measure.
  const z = 2 * Math.PI * rMin * w * Math.sqrt(2 * Math.PI);
  const ring = Math.exp(-((r - rMin) * (r - rMin)) / (2 * w * w)) / z;
  return (1 - o.omega) * diffuse + o.omega * ring;
}

function gaussian2D(r: number, sigma: number): number {
  const s = Math.max(sigma, 1e-3);
  return Math.exp(-(r * r) / (2 * s * s)) / (2 * Math.PI * s * s);
}

/**
 * Non-negative least squares over seven unknowns, by projected Gauss-Seidel on
 * the normal equations. Seven unknowns and a well-conditioned basis: this
 * converges in far fewer than the iterations budgeted here.
 */
function nnls(A: number[][], b: number[], n: number): number[] {
  const ata: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const atb = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < b.length; k++) s += A[k]![i]! * A[k]![j]!;
      ata[i]![j] = s;
    }
    let s = 0;
    for (let k = 0; k < b.length; k++) s += A[k]![i]! * b[k]!;
    atb[i] = s;
  }
  const w = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < 400; iter++) {
    for (let i = 0; i < n; i++) {
      let s = atb[i]!;
      for (let j = 0; j < n; j++) if (j !== i) s -= ata[i]![j]! * w[j]!;
      const d = ata[i]![i]!;
      w[i] = d > 1e-12 ? Math.max(s / d, 0) : 0;
    }
  }
  return w;
}

/**
 * Weights for one channel. The residual is measured under the 2 pi r radial
 * measure, so the fit matches where the *energy* goes rather than where the
 * peak is — a peak-matched fit throws away the tail, which is the whole
 * phenomenon.
 */
export function fitPyramidWeights(o: FitOptions): number[] {
  const sigmas = levelSigmas();
  const rMax = Math.max(o.lengthPx * 8, o.omega > 1e-6 ? o.ringRadiusPx * 2.5 : 0, 16);
  const samples = 96;
  const A: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < samples; k++) {
    const r = (rMax * (k + 0.5)) / samples;
    const measure = Math.sqrt(2 * Math.PI * r);
    A.push(sigmas.map((s) => gaussian2D(r, s) * measure));
    b.push(targetPsf(r, o) * measure);
  }
  const w = nnls(A, b, sigmas.length);
  // Each basis Gaussian already integrates to one, so unit total energy means
  // the weights sum to one. Enforcing it keeps eq. haladd exactly conserving.
  const sum = w.reduce((a, v) => a + v, 0);
  if (sum <= 1e-9) {
    const out = new Array<number>(sigmas.length).fill(0);
    out[0] = 1;
    return out;
  }
  return w.map((v) => v / sum);
}

/**
 * Per-level, per-record weights flattened for `uniform vec3 uW[7]`.
 * Red scatters furthest, so its weights sit on the wider levels — the orange
 * halo comes out of the transport, not out of a tint.
 */
export function pyramidWeightArray(lengthPx: Triple, omega: number, ringRadiusPx: number): Float32Array {
  const out = new Float32Array(PYRAMID_LEVELS * 3);
  for (let c = 0; c < 3; c++) {
    const w = fitPyramidWeights({ lengthPx: lengthPx[c]!, omega, ringRadiusPx });
    for (let j = 0; j < PYRAMID_LEVELS; j++) out[j * 3 + c] = w[j]!;
  }
  return out;
}
