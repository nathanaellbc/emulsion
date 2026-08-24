/**
 * Interlayer inhibition and adjacency effects (§VIII).
 *
 * DIR couplers release an inhibitor where development is happening; it diffuses
 * laterally within a layer and vertically into its neighbours, and suppresses
 * further development where it arrives. Two consequences are separately visible:
 * the Eberhard rim at an edge (acutance), and the inter-image effect, where a
 * strongly green region suppresses red and blue beside it.
 *
 * The naive operator D~_c = D_c - sum_k a_ck (G_sk * D_k) cannot be applied
 * directly: it lowers mean density everywhere, and that DC component is already
 * inside the characteristic curve, because a sensitometric measurement of a real
 * film necessarily includes that film's own inhibition. Splitting the inhibitor
 * into its local mean and its spatial residual leaves
 *
 *     D~_c = D_c + L_c * sum_k a_ck H_sk[D_k],      H_s[D] = D - G_s * D
 *
 * whose pointwise part is absorbed into theta and whose residual is what runs
 * here. H annihilates constants, so a uniform patch is untouched and nothing is
 * counted twice — while every bit of the visible effect, which lives at edges,
 * survives.
 *
 * The sign is worth stating because it looks inverted: where density stands
 * above its neighbourhood mean, the inhibitor has diffused *away* from the peak,
 * so the peak is suppressed less than the fit's pointwise term already assumed,
 * and its density rises. The surround, which receives that inhibitor, falls.
 */

import { pointGamma, type CurveParameters } from './curve';
import { RECORDS, matMulVec, type Matrix3, type Triple } from './triple';

export interface InterlayerProfile {
  /** A = [a_ck]: row is the affected record c, column the releasing record k. */
  readonly coupling: Matrix3;
  /** Short-range diffusion length at the film plane, micrometres. */
  readonly sigma1um: number;
  /** Long-range scale as a multiple of the short one. */
  readonly zeta: number;
  /** Long-scale share of the two-scale kernel at the recommended agitation. */
  readonly w2: number;
  /** Activity exponent. */
  readonly mu: number;
}

export interface InterlayerResolved {
  readonly coupling: Matrix3;
  /** Diffusion lengths in render pixels — the effect is a physical size. */
  readonly sigma1Px: number;
  readonly sigma2Px: number;
  readonly w1: number;
  readonly w2: number;
  readonly mu: number;
  readonly enabled: boolean;
}

/**
 * Eq. dirmatrix, in RGB indexing. The small R-B terms and the strong coupling
 * of both to G are the layer stack showing through: blue on top, then green,
 * then red, so green is adjacent to both and red and blue are not adjacent to
 * each other. The matrix is therefore approximately tridiagonal in layer order
 * and not symmetric in this one.
 */
export const DIR_MATRIX_COLOR_NEGATIVE: Matrix3 = [
  [0.42, 0.26, 0.05],
  [0.19, 0.48, 0.19],
  [0.05, 0.29, 0.38],
];

/** Reversal films use fewer DIR couplers; §VIII scales the whole matrix. */
export const REVERSAL_INHIBITION_SCALE = 0.4;

/** Scales A uniformly. This is the coupler-activity control, and nothing else. */
export function scaleCoupling(a: Matrix3, s: number): Matrix3 {
  return [
    [a[0][0] * s, a[0][1] * s, a[0][2] * s],
    [a[1][0] * s, a[1][1] * s, a[1][2] * s],
    [a[2][0] * s, a[2][1] * s, a[2][2] * s],
  ];
}

/**
 * The two-scale residual of eq. twoscale. A single Gaussian is a poor model of
 * diffusion through a layered gelatin structure: there is a short component
 * within the layer and a long one through the interlayer.
 */
export function twoScaleHighpass(
  d: Triple,
  blur1: Triple,
  blur2: Triple,
  w1: number,
  w2: number,
): Triple {
  return [
    w1 * (d[0] - blur1[0]) + w2 * (d[0] - blur2[0]),
    w1 * (d[1] - blur1[1]) + w2 * (d[1] - blur2[1]),
    w1 * (d[2] - blur1[2]) + w2 * (d[2] - blur2[2]),
  ];
}

/**
 * Eq. activityweight. Inhibitor release follows development activity, not
 * density: in the toe almost nothing is developing, and in the shoulder
 * development has run to completion, so neither releases anything. The
 * normalised point gamma is exactly that quantity, and it is already computed
 * for the grain model.
 *
 * The ratio is `toe - shoulder` once gamma cancels, so it is in [0, 1] for a
 * reversal stock as much as for a negative one — no sign branch is needed.
 */
export function activityWeight(x: Triple, p: CurveParameters, mu: number): Triple {
  const w = RECORDS.map((c) => {
    const ratio = pointGamma(x[c], p, c) / p.gamma[c];
    return Math.pow(Math.max(ratio, 0), mu);
  });
  return [w[0]!, w[1]!, w[2]!];
}

/** Eq. interlayer, pointwise, given the residual and the activity weight. */
export function inhibit(d: Triple, h: Triple, lambda: Triple, a: Matrix3): Triple {
  const coupled = matMulVec(a, h);
  return [
    d[0] + lambda[0] * coupled[0],
    d[1] + lambda[1] * coupled[1],
    d[2] + lambda[2] * coupled[2],
  ];
}

/** Interleaved RGB, `width * height * 3` samples. */
export interface DensityField {
  readonly width: number;
  readonly height: number;
  readonly data: Float64Array;
}

/**
 * Separable Gaussian with clamp-to-edge, matching what the sampler does on the
 * GPU. This exists so the spatial behaviour of the stage is testable at all — a
 * fragment shader cannot assert mean preservation about itself. See
 * DEVIATIONS.md §9 on the duplication that buys.
 */
export function gaussianBlurField(f: DensityField, sigma: number): DensityField {
  const out: DensityField = {
    width: f.width,
    height: f.height,
    data: new Float64Array(f.data),
  };
  if (sigma < 1e-3) return out;

  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(radius + 1);
  let sum = 0;
  for (let i = 0; i <= radius; i++) {
    kernel[i] = Math.exp((-i * i) / (2 * sigma * sigma));
    sum += i === 0 ? kernel[i]! : 2 * kernel[i]!;
  }
  for (let i = 0; i <= radius; i++) kernel[i] = kernel[i]! / sum;

  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  const pass = (src: Float64Array, dst: Float64Array, horizontal: boolean) => {
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = kernel[0]! * src[(y * f.width + x) * 3 + c]!;
          for (let i = 1; i <= radius; i++) {
            const xa = horizontal ? clamp(x - i, f.width - 1) : x;
            const ya = horizontal ? y : clamp(y - i, f.height - 1);
            const xb = horizontal ? clamp(x + i, f.width - 1) : x;
            const yb = horizontal ? y : clamp(y + i, f.height - 1);
            acc += kernel[i]! * (src[(ya * f.width + xa) * 3 + c]! + src[(yb * f.width + xb) * 3 + c]!);
          }
          dst[(y * f.width + x) * 3 + c] = acc;
        }
      }
    }
  };

  const temp = new Float64Array(f.data.length);
  pass(f.data, temp, true);
  pass(temp, out.data, false);
  return out;
}

/**
 * The whole stage over a field: two blurs, the two-scale residual, the coupling
 * matrix, the activity weight, and add. The GPU pass in `gl/shaders/passes.ts`
 * is this function, and divergence between them is a defect in one of the two.
 */
export function interlayerField(
  d: DensityField,
  lambda: DensityField,
  p: InterlayerResolved,
): DensityField {
  const b1 = gaussianBlurField(d, p.sigma1Px);
  const b2 = gaussianBlurField(d, p.sigma2Px);
  const out = new Float64Array(d.data.length);
  for (let i = 0; i < d.data.length; i += 3) {
    const dv: Triple = [d.data[i]!, d.data[i + 1]!, d.data[i + 2]!];
    const h = twoScaleHighpass(
      dv,
      [b1.data[i]!, b1.data[i + 1]!, b1.data[i + 2]!],
      [b2.data[i]!, b2.data[i + 1]!, b2.data[i + 2]!],
      p.w1,
      p.w2,
    );
    const l: Triple = [lambda.data[i]!, lambda.data[i + 1]!, lambda.data[i + 2]!];
    const v = inhibit(dv, h, l, p.coupling);
    out[i] = v[0];
    out[i + 1] = v[1];
    out[i + 2] = v[2];
  }
  return { width: d.width, height: d.height, data: out };
}
