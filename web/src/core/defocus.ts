/**
 * Synthetic defocus (§XIII, "Depth-dependent effects") — the thin-lens half.
 *
 * The paper's circle of confusion,
 *
 *     c(z) = f² / (N (z_f − f)) · |z − z_f| / z
 *          = f² z_f / (N (z_f − f)) · |1/z_f − 1/z|,
 *
 * is linear in inverse distance. That is what makes a *relative* depth map
 * usable at all: Depth Anything V2 predicts affine-invariant disparity, d ∝ 1/z
 * up to an unknown scale and shift, and a blur that is linear in 1/z only
 * needs two anchors to become metric. The far end of the map is taken as
 * infinity (d = 0 after normalisation), and the photographer supplies the
 * focus distance in metres — the one number a camera's focus scale would have
 * shown. Then 1/z = (d / d_f) / z_f, and
 *
 *     c(d) = f² / (N (z_f − f)) · (1 − d / d_f)
 *
 * — signed: positive behind the focal plane, negative in front of it. f, N and
 * the frame then act exactly as they do on a real camera: the same f/2 is
 * shallower on 645 than on Super 16 because the CoC is measured against the
 * frame's pixel pitch. See DEVIATIONS.md, finding 20, for what the
 * infinity anchor costs on a picture with no sky.
 */

import { FRAME_WIDTH_MM, type FilmFormat } from './recipe';

/** A "normal" lens for each frame: roughly its diagonal, rounded to a lens that existed. */
export const NORMAL_FOCAL_MM: Record<FilmFormat, number> = {
  format135: 50,
  format645: 75,
  format66: 80,
  format45: 150,
  super35: 35,
  super16: 16,
  standard8: 12.5,
};

/** The f-number scale in third stops, f/1.2 to f/22. */
export const F_STOPS = [
  1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14,
  16, 18, 20, 22,
] as const;

/** Snaps an f-number to the nearest marked third stop. */
export function nearestStop(n: number): number {
  let best: number = F_STOPS[0];
  for (const s of F_STOPS) if (Math.abs(Math.log(s / n)) < Math.abs(Math.log(best / n))) best = s;
  return best;
}

/**
 * The largest blur disc the gather will draw, as a fraction of the long edge
 * (diameter). f/1.2 on an 85 mm at two metres puts infinity at about 9 % of a
 * 35 mm frame; beyond that the disc is a wash and the gather's samples would
 * be spread too thin to hold a shape.
 */
export const MAX_COC_FRACTION = 0.1;

/**
 * Disparity below which the focus point is treated as "at the far anchor".
 * Dividing by d_f is how the relative map becomes metric; a focus point on the
 * sky itself would otherwise put every other pixel infinitely close.
 */
export const MIN_FOCUS_DISPARITY = 0.02;

/**
 * The permissible circle of confusion: the frame diagonal over 1442, the
 * convention that gives the familiar 0.030 mm for 35 mm. Taken from the
 * picture's own aspect, because the long edge is what maps onto the frame.
 */
export function acceptableCocMm(format: FilmFormat, aspect: number): number {
  const long = FRAME_WIDTH_MM[format];
  const a = Math.max(aspect, 1 / aspect, 1);
  return (long * Math.hypot(1, 1 / a)) / 1442;
}

/** CoC diameter in mm on the film for a subject at infinity (the scale of eq. above). */
export function cocAtInfinityMm(focalMm: number, fNumber: number, focusMm: number): number {
  const zf = Math.max(focusMm, focalMm * 1.25);
  return (focalMm * focalMm) / (fNumber * (zf - focalMm));
}

/** Thin-lens CoC diameter in mm for a subject at `zMm`, focused at `focusMm`. */
export function cocMm(focalMm: number, fNumber: number, focusMm: number, zMm: number): number {
  const zf = Math.max(focusMm, focalMm * 1.25);
  return (focalMm * focalMm * Math.abs(zMm - zf)) / (fNumber * zMm * (zf - focalMm));
}

export interface DepthOfField {
  /** Hyperfocal distance, mm. */
  hyperfocalMm: number;
  /** Near and far limits of acceptable sharpness, mm; far is Infinity past the hyperfocal. */
  nearMm: number;
  farMm: number;
}

/** The classical depth-of-field limits for the permissible CoC `cMm`. */
export function depthOfField(
  focalMm: number,
  fNumber: number,
  focusMm: number,
  cMm: number,
): DepthOfField {
  const f = focalMm;
  const z = Math.max(focusMm, f * 1.25);
  const H = (f * f) / (fNumber * cMm) + f;
  const nearMm = (z * (H - f)) / (H + z - 2 * f);
  const farMm = z < H ? (z * (H - f)) / (H - z) : Infinity;
  return { hyperfocalMm: H, nearMm, farMm };
}

/**
 * Signed CoC diameter in render pixels for a normalised disparity `d`, the
 * host mirror of the shader's `signedCoc`: positive behind the focal plane,
 * negative in front, clamped to the gather's reach.
 */
export function signedCocPx(d: number, focusDisparity: number, scalePx: number, maxPx: number): number {
  const df = Math.max(focusDisparity, MIN_FOCUS_DISPARITY);
  const c = scalePx * (1 - d / df);
  return Math.max(-maxPx, Math.min(maxPx, c));
}
