/**
 * Halation recombination (§XII, eq. haladd), corrected.
 *
 * The paper's form is E'_c = (1 - a b_c) E_c + a b_c (h * S), and it states
 * that this conserves energy "exactly when S = E_c". The source S is not E:
 * it is the thresholded, soft-kneed part of the scene above the halation
 * threshold. The printed form therefore removes a fraction a b_c of *every*
 * pixel's light — a mid-grey far below any threshold loses 15 % of its red
 * on a typical colour stock — and adds back only the thresholded part. The
 * halation control becomes a global colour-balance control, the exact defect
 * the paper's next sentence warns about for exposure.
 *
 * What scatters is the thresholded light, so that is what is removed: the
 * fraction f = S / Y of each pixel's own light, applied to all three of its
 * records so its chromaticity is kept. Below threshold f -> 0 and the pixel
 * is untouched; where S = Y (no threshold) this is the paper's form exactly.
 * See DEVIATIONS.md, finding 16.
 *
 * `gl/shaders/passes.ts` FRAG_HAL_COMBINE is this function; divergence
 * between them is a defect in one of the two.
 */

import { AP1_LUMINANCE } from './colorspace';
import type { Triple } from './triple';

/** The base's amber transmission the dye-transmission control leans toward. */
export const HALO_AMBER: Triple = [1.0, 0.58, 0.24];

/** The halo's colour after the dye-transmission tint and the saturation boost. */
export function haloColour(scattered: Triple, tint: number, boost: number): Triple {
  const [lr, lg, lb] = AP1_LUMINANCE;
  const lum = lr * scattered[0] + lg * scattered[1] + lb * scattered[2];
  const tinted: Triple = [
    scattered[0] + (lum * HALO_AMBER[0] - scattered[0]) * tint,
    scattered[1] + (lum * HALO_AMBER[1] - scattered[1]) * tint,
    scattered[2] + (lum * HALO_AMBER[2] - scattered[2]) * tint,
  ];
  const hl = lr * tinted[0] + lg * tinted[1] + lb * tinted[2];
  return [
    hl + (tinted[0] - hl) * (1 + boost),
    hl + (tinted[1] - hl) * (1 + boost),
    hl + (tinted[2] - hl) * (1 + boost),
  ];
}

/**
 * One pixel: the direct light `e`, the unblurred source term `s` at the same
 * pixel, the recombined halo arriving there, and the per-record weight a b_c.
 */
export function recombineHalation(e: Triple, s: number, halo: Triple, weight: Triple): Triple {
  const [lr, lg, lb] = AP1_LUMINANCE;
  const y = lr * e[0] + lg * e[1] + lb * e[2];
  const f = Math.min(Math.max(s / Math.max(y, 1e-7), 0), 1);
  return [
    Math.max(e[0] * (1 - weight[0] * f) + weight[0] * halo[0], 0),
    Math.max(e[1] * (1 - weight[1] * f) + weight[1] * halo[1], 0),
    Math.max(e[2] * (1 - weight[2] * f) + weight[2] * halo[2], 0),
  ];
}
