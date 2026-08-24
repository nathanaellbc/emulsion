/**
 * The recipe — the complete, serialisable description of an edit. Sparse by
 * intent: it stores what the user chose, not what the chain computed.
 */

import { defaultDevelopStage, type DevelopStage } from './development';

export type FilmFormat =
  | 'format135'
  | 'format645'
  | 'format66'
  | 'format45'
  | 'super35'
  | 'super16'
  | 'standard8';

/** Simulated frame width in millimetres. Drives every physical scaling. */
export const FRAME_WIDTH_MM: Record<FilmFormat, number> = {
  format135: 36.0,
  format645: 56.0,
  format66: 56.0,
  format45: 102.0,
  super35: 24.9,
  super16: 12.5,
  standard8: 10.3,
};

export const FORMAT_LABEL: Record<FilmFormat, string> = {
  format135: '35 mm',
  format645: '645',
  format66: '6×6',
  format45: '4×5',
  super35: 'Super 35',
  super16: 'Super 16',
  standard8: 'Standard 8',
};

export interface CaptureStage {
  /** Stops. */
  exposureCompensation: number;
  /** Exposure index the film was rated at; null means the stock's nominal ISO. */
  filmSpeedOverride: number | null;
  whiteBalanceTempK: number;
  whiteBalanceTint: number;
}

export interface PrintStage {
  /** Printer points, integer, ±12 — one stop per channel. */
  printerLightR: number;
  printerLightG: number;
  printerLightB: number;
  /** Master print density, ±24 points. */
  printDensity: number;
  /** Scales C's off-diagonal terms. Below 1 increases apparent saturation. */
  saturationDensity: number;
  /** Multiplier on the print stock's toe softness, 0.5–2.0. */
  highlightRolloff: number;
  /** Reduces the print's Dmax, lifting the black. */
  shadowLift: number;
  /** Neutral-axis tilt: warms shadows and cools highlights together. */
  neutralAxisWarm: number;
  neutralAxisTint: number;
  /** Retention fraction. 0.45 is ENR, 1.0 is full bleach bypass. */
  silverRetention: number;
}

export interface InterlayerStage {
  /**
   * 0–2; 1 is the stock's own DIR signature. Not called "sharpness": it is the
   * strength of the coupler effect, and it does cross-channel work an
   * unsharp mask cannot.
   */
  couplerActivity: number;
}

export interface GrainStage {
  /** 0–2; 1 means "the granularity the datasheet publishes". */
  amount: number;
  /** Multiplier on the grain kernel size. */
  size: number;
  /** The preset that set these, or null once the user moves a slider by hand. */
  preset: string | null;
}

export interface HalationStage {
  /** null means the stock's own alpha. */
  intensity: number | null;
  /** Multiplier on the red scattering length, ratios held fixed. */
  radius: number;
  /** Threshold in relative exposure. */
  threshold: number;
  /** The preset that set these, or null once a slider is moved by hand. */
  preset: string | null;
}

export interface OutputStage {
  /** 1.0 for a screen in room light, 0.9 for a simulated dark surround. */
  surroundExponent: number;
}

/**
 * Taking-lens diffusion / veiling glare (§XIII, eq. diffusion). A two-term
 * veil convolved with the linear scene before the film is exposed: a tight
 * halo (sigma1) plus a broad veil (sigma2), energy-conserving, so highlights
 * bleed and neighbouring shadows lift. Applied pre-exposure, the film's
 * shoulder compresses it — the restrained look of a real diffusion filter.
 */
export interface GlowStage {
  /** Veil strength w_d: 0 disables, the diffusion presets live below 0.3. */
  strength: number;
  /** Tight-halo scale in micrometres at the film plane. */
  sigma1Um: number;
  /** Broad-veil scale as a multiple of sigma1Um. */
  sigmaRatio: number;
  /** Split rho_d: how much of the veil is the broad term. */
  broad: number;
}

export interface Recipe {
  negativeId: string;
  printId: string;
  chemistryId: string;
  format: FilmFormat;
  seed: number;
  capture: CaptureStage;
  develop: DevelopStage;
  interlayer: InterlayerStage;
  printing: PrintStage;
  grain: GrainStage;
  halation: HalationStage;
  glow: GlowStage;
  output: OutputStage;
}

export function defaultRecipe(): Recipe {
  return {
    negativeId: 'neg.portra400',
    printId: 'prt.2383',
    chemistryId: 'chem.c41',
    format: 'format135',
    seed: 1,
    capture: {
      exposureCompensation: 0,
      filmSpeedOverride: null,
      whiteBalanceTempK: 5500,
      whiteBalanceTint: 0,
    },
    develop: defaultDevelopStage(),
    interlayer: { couplerActivity: 1 },
    printing: {
      printerLightR: 0,
      printerLightG: 0,
      printerLightB: 0,
      printDensity: 0,
      saturationDensity: 1,
      highlightRolloff: 1,
      shadowLift: 0,
      neutralAxisWarm: 0,
      neutralAxisTint: 0,
      silverRetention: 0,
    },
    grain: { amount: 1, size: 1, preset: 'grain.135' },
    halation: { intensity: null, radius: 1, threshold: 1.6, preset: 'hal.stock' },
    glow: { strength: 0, sigma1Um: 24, sigmaRatio: 8, broad: 0.6 },
    output: { surroundExponent: 1 },
  };
}

export function clampRecipe(r: Recipe): Recipe {
  const ip = (v: number, lim: number) => Math.round(Math.min(Math.max(v, -lim), lim));
  const cl = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    ...r,
    capture: {
      ...r.capture,
      exposureCompensation: cl(r.capture.exposureCompensation, -5, 5),
      whiteBalanceTempK: cl(r.capture.whiteBalanceTempK, 2000, 12000),
      whiteBalanceTint: cl(r.capture.whiteBalanceTint, -1, 1),
    },
    develop: {
      ...r.develop,
      pushPull: cl(r.develop.pushPull, -2, 3),
      agitation: cl(r.develop.agitation, 0.2, 2),
      developerConcentration: cl(r.develop.developerConcentration, 0.4, 1.6),
    },
    interlayer: { couplerActivity: cl(r.interlayer.couplerActivity, 0, 2) },
    printing: {
      ...r.printing,
      printerLightR: ip(r.printing.printerLightR, 12),
      printerLightG: ip(r.printing.printerLightG, 12),
      printerLightB: ip(r.printing.printerLightB, 12),
      printDensity: ip(r.printing.printDensity, 24),
      saturationDensity: cl(r.printing.saturationDensity, 0, 2),
      highlightRolloff: cl(r.printing.highlightRolloff, 0.5, 2),
      shadowLift: cl(r.printing.shadowLift, 0, 0.6),
      neutralAxisWarm: cl(r.printing.neutralAxisWarm, -0.3, 0.3),
      neutralAxisTint: cl(r.printing.neutralAxisTint, -0.3, 0.3),
      silverRetention: cl(r.printing.silverRetention, 0, 1),
    },
    grain: {
      amount: cl(r.grain.amount, 0, 2),
      size: cl(r.grain.size, 0.4, 3),
      preset: r.grain.preset ?? null,
    },
    halation: {
      intensity: r.halation.intensity === null ? null : cl(r.halation.intensity, 0, 1),
      radius: cl(r.halation.radius, 0.2, 4),
      threshold: cl(r.halation.threshold, 0.2, 6),
      preset: r.halation.preset ?? null,
    },
    glow: {
      // A persisted recipe from before the stage existed carries no glow block.
      strength: cl(r.glow?.strength ?? 0, 0, 0.5),
      sigma1Um: cl(r.glow?.sigma1Um ?? 24, 4, 200),
      sigmaRatio: cl(r.glow?.sigmaRatio ?? 8, 2, 32),
      broad: cl(r.glow?.broad ?? 0.6, 0, 1),
    },
    output: { surroundExponent: cl(r.output.surroundExponent, 0.8, 1.2) },
  };
}

/** Sorted-key JSON, so two recipes that render identically serialise identically. */
export function canonicalJSON(r: Recipe): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, sort(o[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(r));
}

/** FNV-1a over the canonical bytes. A cache key, not a security primitive. */
export function contentHash(r: Recipe): string {
  const s = canonicalJSON(r);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
