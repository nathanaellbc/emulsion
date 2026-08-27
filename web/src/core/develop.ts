/**
 * The camera develop (§V's missing stage).
 *
 * The design document is strict about the decode: every rendering intent a
 * demosaicer might apply is switched off, and the scene arrives linear and
 * untouched. That is right for the *model* — but a photographer carrying a RAW
 * capture in still has no way to say what the sensor's develop would have done
 * before the film saw the light. §V publishes nothing for it, so this stage is
 * an engineering extension, not physics: every mapping below is recorded in
 * DEVIATIONS.md (finding 14), and nothing about it claims to be a measurement.
 *
 * What it is *not* allowed to do is lie about its position in the chain. The
 * develop lives in the prepare pass — before the log, before the film — with
 * the white balance and the exposure it sits beside, and deliberately outside
 * the LUT-bake domain (see `shaders/passes.ts` and `core/lut.ts`): the film,
 * and every spatial stage driven by the scene (halation's threshold, the glow
 * veil, the interlayer's inhibitor release), sees the *developed* scene, which
 * is the only honest order. The camera develop is what the light looked like
 * when it reached the emulsion.
 *
 * The tone controls are a per-pixel luminance mapping — one scalar gain per
 * pixel, so chromaticity is exactly preserved and a saturated highlight does
 * not rotate its hue because a slider moved. Saturation is the one operator
 * that touches the records separately, and it is the same luminance-preserving
 * mix the halation boost uses, so the house has one saturation, not two.
 */

import type { Triple } from './triple';

/** Scene grey, the tone scale's pivot. Same constant the anchor uses. */
export const SCENE_GREY = 0.18;

/** The luminance floor the log paths already use, keeping log2 finite. */
export const LUMA_FLOOR = 1e-7;

export interface CameraDevelopParams {
  /** Log slope multiplier on stops-over-grey. 1 is untouched. */
  contrast: number;
  /** Stops added at the highlight mask centre; 0 is untouched. */
  highlights: number;
  /** Stops added at the shadow mask centre; 0 is untouched. */
  shadows: number;
  /** Stops added at the white end; 0 is untouched. */
  whites: number;
  /** Stops added at the black end; 0 is untouched. */
  blacks: number;
  /** Saturation factor about scene luminance. 1 is untouched. */
  saturation: number;
}

export const DEFAULT_CAMERA_DEVELOP: CameraDevelopParams = {
  contrast: 1,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 1,
};

/** Slider ranges, the unit the interface exposes, and the truth they clamp to. */
export const CAMERA_LIMITS = {
  contrast: { min: -0.75, max: 0.75 },
  highlights: { min: -1.5, max: 1.5 },
  shadows: { min: -1.5, max: 1.5 },
  whites: { min: -2, max: 2 },
  blacks: { min: -2, max: 2 },
  saturation: { min: 0, max: 2 },
} as const;

/**
 * Mask centres and widths, in stops over scene grey. The logistic shape is the
 * house's own: it is the softplus derivative that builds the toe and shoulder
 * everywhere else, so "the mask begins here" has the same soft knee a film
 * curve does. Blacks act additively in the log domain rather than as a
 * multiplier on light, which keeps the deepest shadows positive where a
 * multiplicative lift cannot.
 *
 * The shadow-side centres are *below* grey and their masks are applied in the
 * mirrored form σ((c−t)/w) — maximal at the low end. See `developLuma`.
 */
export const MASK_HIGHLIGHT = { centre: 1.5, width: 1.0 };
export const MASK_SHADOW = { centre: -1.5, width: 1.0 };
export const MASK_WHITE = { centre: 4.0, width: 2.0 };
export const MASK_BLACK = { centre: -4.0, width: 2.0 };

/**
 * One luminance through the tone controls. Pure and total: any finite input
 * produces a finite, non-negative output.
 *
 * The highlight-side masks (highlights, whites) rise toward the top of the
 * scale; the shadow-side masks (shadows, blacks) fall toward it — σ((c−t)/w),
 * the mirror form, so a shadow lift acts on shadows and barely touches a
 * highlight. Getting this backwards is the classic bug of a parametric curve
 * editor: the mask is maximal wherever the logistic saturates, which without
 * the mirror is the *wrong* end.
 */
export function developLuma(y: number, p: CameraDevelopParams): number {
  const l = Math.log2(Math.max(y, LUMA_FLOOR) / SCENE_GREY);
  let t = l * p.contrast;
  t += p.highlights * logistic((t - MASK_HIGHLIGHT.centre) / MASK_HIGHLIGHT.width);
  t += p.shadows * logistic((MASK_SHADOW.centre - t) / MASK_SHADOW.width);
  t += p.whites * logistic((t - MASK_WHITE.centre) / MASK_WHITE.width);
  t += p.blacks * logistic((MASK_BLACK.centre - t) / MASK_BLACK.width);
  return SCENE_GREY * Math.pow(2, t);
}

/** The per-pixel tone gain: chromaticity is preserved by construction. */
export function toneGain(y: number, p: CameraDevelopParams): number {
  if (y <= LUMA_FLOOR) return developLuma(y, p) / LUMA_FLOOR;
  return developLuma(y, p) / y;
}

/** The logistic function, the stable form. */
function logistic(t: number): number {
  return t >= 0 ? 1 / (1 + Math.exp(-t)) : Math.exp(t) / (1 + Math.exp(t));
}

/**
 * Full RGB through the develop: tone gain, then the luminance-preserving
 * saturation mix in the working space. Exposure and white balance are applied
 * upstream — in the prepare matrix, where they already live — and are not this
 * function's concern.
 */
export function develop(rgb: Triple, p: CameraDevelopParams): Triple {
  const [r, g, b] = rgb;
  const y = 0.2722 * r + 0.6741 * g + 0.0537 * b;
  const gain = toneGain(y, p);
  const s = p.saturation;
  if (s === 1) return [r * gain, g * gain, b * gain];
  const yOut = y * gain;
  return [
    Math.max(yOut + s * (r * gain - yOut), 0),
    Math.max(yOut + s * (g * gain - yOut), 0),
    Math.max(yOut + s * (b * gain - yOut), 0),
  ];
}

/** True when no control is set: lets hot paths skip the stage entirely. */
export function developIsIdentity(p: CameraDevelopParams): boolean {
  return (
    p.contrast === 1 &&
    p.highlights === 0 &&
    p.shadows === 0 &&
    p.whites === 0 &&
    p.blacks === 0 &&
    p.saturation === 1
  );
}
