/**
 * Color management (§V).
 *
 * The working space is ACEScg (AP1 primaries, linear, D60). It costs one
 * matrix multiply on each end and buys gamut headroom that keeps channels from
 * going negative mid-pipeline — which matters enormously, because log10 of a
 * negative number is undefined and one clamped channel produces a visible hue
 * shift in saturated highlights.
 */

import { IDENTITY3, matMul, matInverse, type Matrix3, type Triple } from './triple';

/** Decoded Display P3 linear to ACEScg (eq. minval). */
export const M_P3_TO_AP1: Matrix3 = [
  [0.9525, 0.0343, 0.0132],
  [0.017, 0.9754, 0.0076],
  [-0.0018, 0.0107, 0.9911],
];

export const M_AP1_TO_P3: Matrix3 = matInverse(M_P3_TO_AP1);

/** sRGB linear to Display P3 linear, both D65. */
export const M_SRGB_TO_P3: Matrix3 = [
  [0.8225, 0.1774, 0.0],
  [0.0332, 0.9669, 0.0],
  [0.0171, 0.0724, 0.9105],
];

export const M_SRGB_TO_AP1: Matrix3 = matMul(M_P3_TO_AP1, M_SRGB_TO_P3);

/**
 * ACES2065-1 (AP0) to ACEScg (AP1). This is the RAW path: LibRaw is asked for
 * ACES output because AP0 encloses every colour a sensor can report, so nothing
 * is clipped before the working space sees it.
 */
export const M_AP0_TO_AP1: Matrix3 = [
  [1.4514393161, -0.2365107469, -0.2149285693],
  [-0.0765537734, 1.1762296998, -0.0996759264],
  [0.0083161484, -0.0060324498, 0.9977163014],
];

export const M_AP1_TO_XYZ: Matrix3 = [
  [0.6624541811, 0.1340042065, 0.156187687],
  [0.2722287168, 0.6740817658, 0.0536895174],
  [-0.0055746495, 0.0040607335, 1.0103391003],
];

export const M_XYZ_TO_AP1: Matrix3 = [
  [1.6410233797, -0.3248032942, -0.2364246952],
  [-0.6636628587, 1.6153315917, 0.0167563477],
  [0.0117218943, -0.008284442, 0.9883948585],
];

/** CAT02, XYZ to sharpened cone responses. */
export const M_XYZ_TO_LMS: Matrix3 = [
  [0.7328, 0.4296, -0.1624],
  [-0.7036, 1.6975, 0.0061],
  [0.003, 0.0136, 0.9834],
];

export const M_LMS_TO_XYZ: Matrix3 = matInverse(M_XYZ_TO_LMS);

/** Luminance weights in AP1, from the second row of M_AP1_TO_XYZ. */
export const AP1_LUMINANCE: Triple = M_AP1_TO_XYZ[1];

/** The illuminant the daylight stocks are balanced for. */
export const REFERENCE_TEMP_K = 5500;

/**
 * Correlated colour temperature to CIE 1931 xy. Kim et al.'s cubic for the
 * Planckian locus over 1667–25000 K, which is well inside the range the UI
 * exposes.
 */
export function cctToXy(tempK: number): { x: number; y: number } {
  const T = Math.min(Math.max(tempK, 1667), 25000);
  const t = 1000 / T;
  let x: number;
  if (T <= 4000) {
    x = -0.2661239 * t * t * t - 0.2343589 * t * t + 0.8776956 * t + 0.17991;
  } else {
    x = -3.0258469 * t * t * t + 2.1070379 * t * t + 0.2226347 * t + 0.24039;
  }
  let y: number;
  if (T <= 2222) {
    y = -1.1063814 * x * x * x - 1.3481102 * x * x + 2.18555832 * x - 0.20219683;
  } else if (T <= 4000) {
    y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.081758 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  }
  return { x, y };
}

/**
 * Tint moves perpendicular to the Planckian locus in CIE 1960 UCS, which is
 * what "green–magenta" means physically. Positive is green.
 */
export function illuminantXYZ(tempK: number, tint: number): Triple {
  const { x, y } = cctToXy(tempK);
  const denom = -2 * x + 12 * y + 3;
  let u = (4 * x) / denom;
  let v = (6 * y) / denom;
  v += tint * 0.05;
  const d = 2 * u - 8 * v + 4;
  const xp = (3 * u) / d;
  const yp = (2 * v) / d;
  if (yp <= 1e-6) return [1, 1, 1];
  return [xp / yp, 1, (1 - xp - yp) / yp];
}

/**
 * White balance as a von Kries adaptation in CAT02 cone space rather than an
 * RGB channel gain, because channel gain in a wide-gamut space rotates hue in
 * saturated colours. Both matrices and the diagonal are constant per frame, so
 * the whole operator collapses to one 3x3 on the host.
 */
export function whiteBalanceMatrix(tempK: number, tint: number): Matrix3 {
  const src = illuminantXYZ(tempK, tint);
  const dst = illuminantXYZ(REFERENCE_TEMP_K, 0);
  const toLms = matMul(M_XYZ_TO_LMS, M_AP1_TO_XYZ);
  const cone = (xyz: Triple): Triple => [
    M_XYZ_TO_LMS[0][0] * xyz[0] + M_XYZ_TO_LMS[0][1] * xyz[1] + M_XYZ_TO_LMS[0][2] * xyz[2],
    M_XYZ_TO_LMS[1][0] * xyz[0] + M_XYZ_TO_LMS[1][1] * xyz[1] + M_XYZ_TO_LMS[1][2] * xyz[2],
    M_XYZ_TO_LMS[2][0] * xyz[0] + M_XYZ_TO_LMS[2][1] * xyz[1] + M_XYZ_TO_LMS[2][2] * xyz[2],
  ];
  const s = cone(src);
  const d = cone(dst);
  const gain: Matrix3 = [
    [d[0] / s[0], 0, 0],
    [0, d[1] / s[1], 0],
    [0, 0, d[2] / s[2]],
  ];
  const fromLms = matMul(M_XYZ_TO_AP1, M_LMS_TO_XYZ);
  return matMul(fromLms, matMul(gain, toLms));
}

/** sRGB / Display P3 electro-optical transfer function. */
export function srgbEotf(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function srgbOetf(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export { IDENTITY3 };
