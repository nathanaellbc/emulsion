/**
 * Parameter resolution — run once per edit, never per pixel.
 *
 *   stock defaults -> chemistry modulation -> recipe values -> resolved
 *
 * The output is dense: no optionals, no lookups, nothing the shader has to
 * decide. Everything expensive (the aim balance's Newton iterations, the
 * chemistry reshape, every matrix product) happens here, so the hot path is
 * total and cannot fail.
 */

import { densityWithMask, type CurveParameters } from './curve';
import { activity, modulate } from './development';
import { card, speedPoint, type SensitometricCard } from './sensitometry';
import {
  M_AP0_TO_AP1,
  M_AP1_TO_P3,
  M_P3_TO_AP1,
  M_SRGB_TO_AP1,
  whiteBalanceMatrix,
} from './colorspace';
import {
  PRINTER_POINT,
  aimBalance,
  crosstalkMatrix,
  type PrintCurve,
  type PrintProfile,
} from './print';
import { scaleCoupling, type InterlayerResolved } from './interlayer';
import { chemistryById } from './profiles/chemistry';
import {
  DAYLIGHT_AIM_K,
  HALATION_LENGTH_RATIOS,
  negativeById,
  type NegativeProfile,
} from './profiles/negatives';
import { printStockById } from './profiles/printStocks';
import { printLutEntry, printLutIlluminants } from './printLuts';
import { FRAME_WIDTH_MM, contentHash, type Recipe } from './recipe';
import { matMul, triFill, type Matrix3, type Triple } from './triple';

/**
 * Middle grey sits log10(12.5) above the speed point: the ISO relation
 * H_mid / H_speed = (10/S) / (0.8/S).
 *
 * The paper's eq. isoshift as printed carries `+log10(S/S0)`, whose sign
 * contradicts the sentence beneath it ("shooting Portra 400 at 800 shifts
 * logE_film by -0.301"). The prose is right and the equation's sign is wrong;
 * see DEVIATIONS.md, finding 1.
 */
export const MIDDLE_GREY_ABOVE_SPEED_POINT = Math.log10(12.5);

/** RMS granularity is published through a 48 um diameter circular aperture. */
const APERTURE_48_AREA_UM2 = Math.PI * 24 * 24;

export interface HalationResolved {
  /** Per-channel scattering length in render pixels. */
  lengthPx: Triple;
  /** alpha * beta_c, the per-channel mixing weight of eq. haladd. */
  weight: Triple;
  threshold: number;
  kneeSoftness: number;
  /** Base-reflection ring weight. */
  omega: number;
  /**
   * How far the recombined halo leans into the base's amber transmission:
   * 0 keeps the transport's per-channel weights, 1 tints the halo fully.
   */
  tint: number;
  /** Saturation boost of the recombined halo. */
  boost: number;
  enabled: boolean;
}

export interface GlowResolved {
  /** Veil strength w_d (eq. diffusion). */
  strength: number;
  /** Tight-halo and broad-veil Gaussian sigmas in render pixels. */
  sigma1Px: number;
  sigma2Px: number;
  /** Split rho_d: the broad term's share of the veil. */
  broad: number;
  enabled: boolean;
}

export interface GrainResolved {
  /** Field standard deviation in density at the reference point p = peak. */
  sigmaRef: number;
  /** Grain kernel scales in render pixels. */
  sigma1Px: number;
  sigma2Px: number;
  /** Clustering fraction. */
  chi: number;
  /** Shape exponents and the normaliser that puts the peak at 1. */
  nu: readonly [number, number];
  nuPeak: number;
  /** Density-dependence bias exponent: where in the tone scale grain shows. */
  responseGamma: number;
  /** Lower-triangular Cholesky factor of the record correlation matrix. */
  cholesky: Matrix3;
  amount: number;
  seed: number;
  enabled: boolean;
}

export interface ResolvedParameters {
  readonly recipe: Recipe;
  readonly negative: NegativeProfile;
  readonly print: PrintProfile;

  /** Source encoding to ACEScg, white balance folded in. */
  readonly inputMatrix: Matrix3;
  /**
   * The white balance alone. Kept separate from `inputMatrix` for the LUT
   * export, which declares an AP1 input and must therefore bake the adaptation
   * but not the source-primaries matrix.
   */
  readonly whiteBalance: Matrix3;
  readonly outputMatrix: Matrix3;

  /** log10(E) + this = the film's log exposure, before the layer balance. */
  readonly anchorShift: number;
  readonly exposureGain: number;
  readonly balanceShift: Triple;

  /** Monochrome stocks collapse to one record before the curve. */
  readonly monochrome: boolean;
  readonly panWeights: Triple;

  readonly curve: CurveParameters;
  readonly printCurve: PrintCurve;
  readonly crosstalk: Matrix3;
  /** log10 L_aim + 0.025 (p_c + p_master), already summed. */
  readonly printExposureOffset: Triple;
  readonly silverRetention: number;
  readonly neutralAxis: Triple;
  readonly bypass: boolean;
  readonly surroundExponent: number;

  /**
   * Which engine the print stage renders through. 'lut' only where the user
   * chose it and a measurement exists for the stock; everything else falls
   * back to the model, silently and by rule rather than by accident.
   */
  readonly printEngine: 'model' | 'lut';
  /**
   * The measurement, when the stock has one — the Cineon anchor (the stock's
   * own correctly exposed neutral density, code 445) plus what the interface
   * says about it. Present regardless of the engine choice, so the toggle can
   * offer what exists and the engine can switch without a re-resolve.
   */
  readonly printLut: {
    readonly id: string;
    readonly displayName: string;
    readonly source: string;
    readonly anchor: Triple;
    readonly illuminant: 'D55' | 'D60' | 'D65';
    /** The illuminants this stock actually has measurements for. */
    readonly illuminants: readonly ('D55' | 'D60' | 'D65')[];
  } | null;

  /** Subtractive grading: dye-density offsets on the print, and the master. */
  readonly subtractive: {
    readonly cyan: number;
    readonly magenta: number;
    readonly yellow: number;
    readonly density: number;
    readonly densityMode: 'suppress' | 'multiply';
  };

  readonly halation: HalationResolved;
  readonly interlayer: InterlayerResolved;
  readonly grain: GrainResolved;
  readonly glow: GlowResolved;

  readonly developmentActivity: number;
  readonly sensitometry: SensitometricCard;
  /** Identity of the edit these parameters came from; stamped into exports. */
  readonly recipeHash: string;
  readonly warnings: readonly string[];
}

export type SourceSpace = 'srgb' | 'displayP3' | 'linearAP1' | 'acesAP0';

export interface ResolveContext {
  /** Render target width in pixels — grain and halation are physical sizes. */
  renderWidthPx: number;
  sourceSpace: SourceSpace;
}

function sourceMatrix(space: SourceSpace): Matrix3 {
  switch (space) {
    case 'srgb':
      return M_SRGB_TO_AP1;
    case 'displayP3':
      return M_P3_TO_AP1;
    case 'acesAP0':
      return M_AP0_TO_AP1;
    case 'linearAP1':
      return [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
  }
}

/**
 * How far the declared scene illuminant sits from the one a stock is balanced
 * for, as a fraction of the daylight-to-aim distance. 1 means the scene was
 * daylight and the stock's full layer balance applies; 0 means the scene
 * matched the stock and no cast arises.
 */
function illuminantMismatch(sceneK: number, aimK: number): number {
  const mired = (k: number) => 1e6 / Math.max(k, 1);
  const span = mired(DAYLIGHT_AIM_K) - mired(aimK);
  if (Math.abs(span) < 1e-6) return 0;
  const t = (mired(sceneK) - mired(aimK)) / span;
  // Beyond the endpoints the extrapolation stays physical for a while, then
  // stops meaning anything; clamp where it stops.
  return Math.max(-0.5, Math.min(2, t));
}

/** Cholesky factor of the equicorrelation matrix with unit diagonal. */
function choleskyEqui(rho: number): Matrix3 {
  if (rho >= 1 - 1e-6) {
    // One silver image: all three records receive the identical field.
    return [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ];
  }
  const r = Math.max(Math.min(rho, 0.999), -0.499);
  const l22 = Math.sqrt(Math.max(1 - r * r, 1e-9));
  const l32 = (r - r * r) / l22;
  const l33 = Math.sqrt(Math.max(1 - r * r - l32 * l32, 1e-9));
  return [
    [1, 0, 0],
    [r, l22, 0],
    [r, l32, l33],
  ];
}

function buildPrintCurve(p: PrintProfile, recipe: Recipe): PrintCurve {
  const { highlightRolloff, shadowLift } = recipe.printing;
  if (p.bypass) {
    return {
      dMin: triFill(0),
      deltaD: triFill(1),
      gamma: triFill(1),
      kappaT: triFill(0.1),
      kappaS: triFill(0.1),
    };
  }
  // Shadow lift reduces the print's Dmax, which is a reduction of its range.
  const deltaD = Math.max(p.deltaD * (1 - shadowLift), 0.2);
  return {
    dMin: triFill(p.dMin),
    deltaD: triFill(deltaD),
    gamma: triFill(p.gamma),
    kappaT: triFill(Math.max(p.kappaT * highlightRolloff, 1e-3)),
    kappaS: triFill(Math.max(p.kappaS, 1e-3)),
  };
}

export function resolve(recipe: Recipe, ctx: ResolveContext): ResolvedParameters {
  const warnings: string[] = [];
  const negative = negativeById(recipe.negativeId);
  const print = printStockById(recipe.printId);
  const chemistry = chemistryById(recipe.chemistryId);

  // --- Development -------------------------------------------------------
  const A = activity(recipe.develop, chemistry);
  const curve = modulate(negative.curve, A, chemistry);

  for (let c = 0 as 0 | 1 | 2; c < 3; c = (c + 1) as 0 | 1 | 2) {
    if (curve.deltaD[c] < 4 * (curve.kappaT[c] + curve.kappaS[c])) {
      warnings.push(
        `Development has driven the ${['red', 'green', 'blue'][c]} record past the well-formedness bound — the straight line has closed up.`,
      );
      break;
    }
  }

  // --- Exposure anchor ---------------------------------------------------
  // Anchored on the *nominal* stock speed, not the developed one: the anchor
  // describes how much light reached the film, which development cannot change.
  //
  // The reference end of the curve depends on polarity. ISO 5800 anchors a
  // colour *negative* to the toe (Dmin + 0.10), which is its shadow; mid-grey
  // sits log10(12.5) above it. ISO 2240 anchors a colour *reversal* stock to
  // the highlight instead — for gamma < 0 the toe of the characteristic curve
  // is the *white* end, so anchoring mid-grey above the speed point drives the
  // whole image onto the shoulder (the >5-stop blowout this fixes). For a
  // reversal stock mid-grey is referenced down from Dmin by the same interval,
  // which lands it on the straight line.
  const nominalSpeedPoint = speedPoint(negative.curve, 1);
  const reversal = negative.curve.gamma[1] < 0;
  const ei = recipe.capture.filmSpeedOverride ?? negative.iso;
  const anchorShift = reversal
    ? -Math.log10(0.18) +
      nominalSpeedPoint -
      MIDDLE_GREY_ABOVE_SPEED_POINT -
      Math.log10(ei / negative.iso)
    : -Math.log10(0.18) +
      nominalSpeedPoint +
      MIDDLE_GREY_ABOVE_SPEED_POINT -
      Math.log10(ei / negative.iso);

  // --- Colour ------------------------------------------------------------
  const wb = whiteBalanceMatrix(recipe.capture.whiteBalanceTempK, recipe.capture.whiteBalanceTint);
  const inputMatrix = matMul(wb, sourceMatrix(ctx.sourceSpace));

  // --- Layer balance -----------------------------------------------------
  // §V derives the layer balance from the ratio of layer sensitivities against
  // 3200 K versus D55, so it is a *difference* between two illuminants and only
  // applies in full when the scene was the daylight one. Telling the app the
  // light was tungsten takes the cast away, exactly as putting an 85B on the
  // camera would — the balance interpolates on mired, which is the scale
  // colour temperature is actually linear in.
  const balanceScale = illuminantMismatch(
    recipe.capture.whiteBalanceTempK,
    negative.aimIlluminantK,
  );
  const balanceShift: Triple = [
    curve.balanceShift[0] * balanceScale,
    curve.balanceShift[1] * balanceScale,
    curve.balanceShift[2] * balanceScale,
  ];

  // --- Print -------------------------------------------------------------
  const printCurve = buildPrintCurve(print, recipe);
  const crosstalk = crosstalkMatrix(print, recipe.printing.saturationDensity);
  const lutEntry = printLutEntry(recipe.printId);
  const printEngine: 'model' | 'lut' =
    recipe.printEngine === 'lut' && lutEntry !== null && !print.bypass ? 'lut' : 'model';

  // The lab balances the stock under its intended illuminant, so the layer
  // balance is deliberately excluded here: including it would cancel the very
  // tungsten cast the model exists to reproduce.
  const neutralLogE = anchorShift + Math.log10(0.18);
  const neutralDensity = densityWithMask(triFill(neutralLogE), curve);

  let printExposureOffset: Triple = [0, 0, 0];
  if (printEngine === 'lut') {
    // The measurement carries its own balance: a normally printed negative is
    // defined by the Cineon anchor, so the model's aim balance must not be
    // added on top of it — only the user's lights move the print.
    const master = PRINTER_POINT * recipe.printing.printDensity;
    printExposureOffset = [
      PRINTER_POINT * recipe.printing.printerLightR + master,
      PRINTER_POINT * recipe.printing.printerLightG + master,
      PRINTER_POINT * recipe.printing.printerLightB + master,
    ];
  } else if (!print.bypass) {
    try {
      const aim = aimBalance(neutralDensity, printCurve, print, crosstalk, negative.id);
      const master = PRINTER_POINT * recipe.printing.printDensity;
      printExposureOffset = [
        aim[0] + PRINTER_POINT * recipe.printing.printerLightR + master,
        aim[1] + PRINTER_POINT * recipe.printing.printerLightG + master,
        aim[2] + PRINTER_POINT * recipe.printing.printerLightB + master,
      ];
    } catch (err) {
      warnings.push(
        `Aim balance did not converge for ${negative.displayName} on ${print.displayName}; the print is unbalanced.`,
      );
      printExposureOffset = [0, 0, 0];
    }
  }

  // --- Physical scaling --------------------------------------------------
  const pitchUm = (FRAME_WIDTH_MM[recipe.format] * 1000) / Math.max(ctx.renderWidthPx, 1);

  const g = negative.grain;
  const sigma1Px = (g.sigma1um * recipe.grain.size) / pitchUm;
  const sigma2Px = sigma1Px * g.zeta;
  const sigmaEffUm2 =
    (1 - g.chi) * Math.pow(g.sigma1um * recipe.grain.size, 2) +
    g.chi * Math.pow(g.sigma1um * recipe.grain.size * g.zeta, 2);
  // Selwyn scaling diverges as the aperture shrinks; the grain kernel's own
  // correlation area is the physical floor at which it stops.
  const minArea = Math.max(4 * Math.PI * sigmaEffUm2, 1e-3);
  const apertureArea = Math.max(pitchUm * pitchUm, minArea);
  const sigmaRef = g.selwyn * Math.sqrt(APERTURE_48_AREA_UM2 / apertureArea);

  const [nu1, nu2] = g.nu;
  const pPeak = nu1 / (nu1 + nu2);
  const nuPeak = Math.pow(pPeak, nu1) * Math.pow(1 - pPeak, nu2);

  // Film response: a bias exponent on the grain's density dependence. The
  // shape function is normalised in its own argument, so reparameterising
  // p -> p^gamma moves where the grain peaks without touching its amplitude.
  // +1 (a positive scan's look) pushes the peak toward the print's
  // highlights, -1 (a negative scan's) into its shadows. The paper publishes
  // no such law; the exponent is an engineering default, recorded in
  // DEVIATIONS.md.
  const responseGamma = Math.pow(2, -2 * recipe.grain.response);

  // §VIII exposes agitation as the second interlayer control, and it is the one
  // that rewards knowing darkroom practice: standing development lets the
  // inhibitor travel before it is swept away, so the long scale reaches further
  // and carries more of the effect. Brisk agitation does the opposite.
  const il = negative.interlayer;
  const agitationReach = Math.pow(recipe.develop.agitation, -0.5);
  const ilSigma1Px = il.sigma1um / pitchUm;
  const ilW2 = Math.min(Math.max(il.w2 * agitationReach, 0.05), 0.9);

  const halationAlpha = recipe.halation.intensity ?? negative.halation.alpha;
  const lengthRedPx = (negative.halation.lengthRedUm * recipe.halation.radius) / pitchUm;
  return {
    recipe,
    negative,
    print,
    inputMatrix,
    whiteBalance: wb,
    outputMatrix: M_AP1_TO_P3,
    anchorShift,
    exposureGain: Math.pow(2, recipe.capture.exposureCompensation),
    balanceShift,
    monochrome: negative.family === 'monochrome',
    panWeights: negative.panWeights ?? [0.3, 0.59, 0.11],
    curve,
    printCurve,
    crosstalk,
    printExposureOffset,
    printEngine,
    printLut: lutEntry
      ? {
          id: recipe.printId,
          displayName: lutEntry.displayName,
          source: lutEntry.source,
          anchor: neutralDensity,
          illuminant: recipe.printIlluminant,
          illuminants: printLutIlluminants(recipe.printId),
        }
      : null,
    subtractive: { ...recipe.subtractive },
    silverRetention: recipe.printing.silverRetention,
    neutralAxis: [recipe.printing.neutralAxisWarm, 0, recipe.printing.neutralAxisTint],
    bypass: print.bypass,
    surroundExponent: recipe.output.surroundExponent,
    halation: {
      lengthPx: [
        lengthRedPx * HALATION_LENGTH_RATIOS[0],
        lengthRedPx * HALATION_LENGTH_RATIOS[1],
        lengthRedPx * HALATION_LENGTH_RATIOS[2],
      ],
      weight: [
        halationAlpha * negative.halation.bias[0],
        halationAlpha * negative.halation.bias[1],
        halationAlpha * negative.halation.bias[2],
      ],
      threshold: recipe.halation.threshold,
      kneeSoftness: 0.15,
      omega: negative.halation.omega,
      tint: recipe.halation.dyeTransmission,
      boost: recipe.halation.boost,
      enabled: halationAlpha > 1e-4 && lengthRedPx > 0.05,
    },
    interlayer: {
      coupling: scaleCoupling(il.coupling, recipe.interlayer.couplerActivity),
      sigma1Px: ilSigma1Px,
      sigma2Px: ilSigma1Px * il.zeta * agitationReach,
      w1: 1 - ilW2,
      w2: ilW2,
      mu: il.mu,
      // The scales are physical, so a coarse render simply cannot resolve them:
      // at 2048 across a 35 mm frame the long scale is a third of a pixel. The
      // stage stays honest about that rather than being floored into visibility
      // — see DEVIATIONS.md, finding 7 — and switches off entirely once even
      // the long scale has nothing left to say.
      enabled:
        recipe.interlayer.couplerActivity > 1e-3 && ilSigma1Px * il.zeta * agitationReach > 0.25,
    },
    grain: {
      sigmaRef,
      sigma1Px: Math.max(sigma1Px, 0.35),
      sigma2Px: Math.max(sigma2Px, 0.5),
      chi: g.chi,
      nu: g.nu,
      nuPeak,
      responseGamma,
      // Color variation interpolates the records' correlation: 0 is silver-
      // mono grain (one field, all three records identical), 1 is the stock's
      // own chroma grain.
      cholesky: choleskyEqui(1 - recipe.grain.colorMix * (1 - g.phi)),
      amount: recipe.grain.amount,
      seed: recipe.seed,
      enabled: recipe.grain.amount > 1e-3,
    },
    glow: (() => {
      // §XIII eq. diffusion, pre-exposure. The tight halo is a physical size at
      // the film plane, so it scales with the render's pixel pitch exactly the
      // way grain and halation do; the broad veil is a fixed multiple of it.
      const s1 = recipe.glow.sigma1Um / pitchUm;
      const s2 = s1 * recipe.glow.sigmaRatio;
      return {
        strength: recipe.glow.strength,
        sigma1Px: s1,
        sigma2Px: s2,
        broad: recipe.glow.broad,
        // No visible veil below a strength floor, and nothing to convolve once
        // even the tight halo is under a pixel.
        enabled: recipe.glow.strength > 1e-3 && s2 > 0.25,
      };
    })(),
    developmentActivity: A,
    sensitometry: card(curve),
    recipeHash: contentHash(recipe),
    warnings,
  };
}
