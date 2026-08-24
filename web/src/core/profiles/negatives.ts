/**
 * Negative stock profiles (Appendix A).
 *
 * Stored the way the appendix stores them — a green record plus per-record
 * offsets — because that makes crossover a reviewable quantity rather than an
 * accident of three separate fits. `expandCurve` resolves the offsets into
 * complete Triples once, at load, so the evaluation path never sees the
 * offset encoding.
 */

import type { CurveParameters } from '../curve';
import {
  DIR_MATRIX_COLOR_NEGATIVE,
  REVERSAL_INHIBITION_SCALE,
  scaleCoupling,
  type InterlayerProfile,
} from '../interlayer';
import { triFill, type Matrix3, type Triple } from '../triple';

export type StockFamily = 'colorNegative' | 'transparency' | 'monochrome';
export type FitStatus = 'M' | 'P' | 'E';

/** Green-record parameters, exactly as Table "Green-Record Characteristic Curve Parameters". */
interface GreenRecord {
  gamma: number;
  deltaD: number;
  x0: number;
  kappaT: number;
  kappaS: number;
  dMin: number;
}

export interface GrainParameters {
  /** Selwyn granularity, RMS through a 48 um aperture (the published value / 1000). */
  readonly selwyn: number;
  readonly sigma1um: number;
  /** Clustering fraction. */
  readonly chi: number;
  /** Cluster scale: sigma2 = zeta * sigma1. */
  readonly zeta: number;
  /** Inter-record correlation; 1.0 for monochrome, where there is one silver image. */
  readonly phi: number;
  /** Shape exponents: sigma_D^2 proportional to p^nu1 (1-p)^nu2. */
  readonly nu: readonly [number, number];
}

export interface HalationParameters {
  readonly alpha: number;
  readonly lengthRedUm: number;
  /** Base-reflection ring weight. */
  readonly omega: number;
  readonly bias: Triple;
}

export interface NegativeProfile {
  readonly id: string;
  readonly displayName: string;
  readonly family: StockFamily;
  readonly process: string;
  readonly chemistryId: string;
  readonly iso: number;
  readonly fitStatus: FitStatus;
  readonly note: string;
  /** Appendix A's printed x0 for the green record, before the speed correction. */
  readonly publishedX0: number;
  readonly curve: CurveParameters;
  readonly grain: GrainParameters;
  readonly halation: HalationParameters;
  readonly interlayer: InterlayerProfile;
  readonly defaultPrint: string;
  /** Panchromatic weights for monochrome stocks (eq. pan). */
  readonly panWeights: Triple | null;
  /**
   * The illuminant the stock's layer speeds are balanced for. The layer balance
   * of eq. tungsten is the *difference* between this and D55, so it applies in
   * full only when the scene was daylight and vanishes when the scene matched
   * what the stock was made for.
   */
  readonly aimIlluminantK: number;
}

/** Per-record offsets relative to the green record, by family. */
const OFFSETS = {
  colorNegative: {
    gamma: [-0.02, 0, 0.03],
    deltaD: [0.05, 0, -0.05],
    x0: [-0.05, 0, 0.05],
    kappaT: [0.01, 0, -0.01],
    kappaS: [0.01, 0, 0.0],
    // Absolute, not an offset: this is the orange mask, the one quantity read directly.
    dMinAbsolute: [0.58, null, 1.28] as [number, null, number],
    maskDepletion: [0.0, 0.06, 0.1],
  },
  transparency: {
    gamma: [-0.06, 0, 0.08],
    deltaD: [0.04, 0, -0.07],
    x0: [-0.03, 0, 0.04],
    kappaT: [0.008, 0, -0.006],
    kappaS: [0.006, 0, -0.004],
    dMinAbsolute: [0.11, null, 0.12] as [number, null, number],
    maskDepletion: [0, 0, 0],
  },
  monochrome: {
    gamma: [0, 0, 0],
    deltaD: [0, 0, 0],
    x0: [0, 0, 0],
    kappaT: [0, 0, 0],
    kappaS: [0, 0, 0],
    dMinAbsolute: [null, null, null] as [null, null, null],
    maskDepletion: [0, 0, 0],
  },
} as const;

/**
 * Places the green record so the stock actually has its rated speed.
 *
 * Appendix A says every x0 is derived from the rated ISO via S = 0.8/10^x_sp,
 * but the published column behaves as though x_sp were x0 itself. §VI puts the
 * speed point at x0 + (κt/γ)·ln(e^(0.10/κt) − 1), a κt-dependent offset that is
 * nowhere near zero: HP5 and Vision3 500T come out 19% fast, Ektar 4% slow.
 *
 * Shipping that would mean a stock that renders but is not the stock named on
 * it — every exposure calculation, every EI rating, and the meaning of "push
 * one stop" would be quietly wrong. So x0 is recomputed here from the
 * appendix's *stated derivation* rather than its printed column, which changes
 * only where the curve sits on the exposure axis and nothing about its shape.
 * The published value stays in the table above so the correction is auditable.
 * See DEVIATIONS.md, finding 2.
 */
function speedCorrectedX0(g: GreenRecord, iso: number): number {
  const drift = (g.kappaT / g.gamma) * Math.log(Math.expm1(0.1 / g.kappaT));
  return Math.log10(0.8 / iso) - drift;
}

function expandCurve(g: GreenRecord, family: StockFamily, balanceShift: Triple): CurveParameters {
  const o = OFFSETS[family];
  const spread = (base: number, offs: readonly number[]): Triple => [
    base + offs[0]!,
    base + offs[1]!,
    base + offs[2]!,
  ];
  const dMin: Triple = [
    o.dMinAbsolute[0] ?? g.dMin,
    g.dMin,
    o.dMinAbsolute[2] ?? g.dMin,
  ];
  return {
    gamma: spread(g.gamma, o.gamma),
    deltaD: spread(g.deltaD, o.deltaD),
    x0: spread(g.x0, o.x0),
    kappaT: spread(g.kappaT, o.kappaT),
    kappaS: spread(g.kappaS, o.kappaS),
    dMin,
    maskDepletion: [...o.maskDepletion] as unknown as Triple,
    balanceShift,
  };
}

/**
 * Interlayer signatures by family (§VIII). The paper publishes one
 * representative matrix for a modern colour negative and two family rules — a
 * monochrome stock has a scalar with no cross terms, a transparency has every
 * entry scaled by about 0.4 — and no per-stock column. Family defaults are
 * therefore what ships, rather than eleven invented signatures; see
 * DEVIATIONS.md §8.
 *
 * The scales are the paper's: sigma_1 = 1.2 um within the layer, sigma_2 = 5
 * sigma_1 through the interlayer, both at the film plane.
 */
const MONO_DIR_ACTIVITY = 0.43;
const MONO_DIR_MATRIX: Matrix3 = [
  [MONO_DIR_ACTIVITY, 0, 0],
  [0, MONO_DIR_ACTIVITY, 0],
  [0, 0, MONO_DIR_ACTIVITY],
];

const INTERLAYER: Record<StockFamily, InterlayerProfile> = {
  colorNegative: {
    coupling: DIR_MATRIX_COLOR_NEGATIVE,
    sigma1um: 1.2,
    zeta: 5,
    w2: 0.35,
    mu: 1.0,
  },
  transparency: {
    coupling: scaleCoupling(DIR_MATRIX_COLOR_NEGATIVE, REVERSAL_INHIBITION_SCALE),
    sigma1um: 1.2,
    zeta: 5,
    w2: 0.35,
    mu: 1.0,
  },
  monochrome: {
    coupling: MONO_DIR_MATRIX,
    sigma1um: 1.2,
    zeta: 5,
    w2: 0.35,
    mu: 1.0,
  },
};

/**
 * The stock-less negative.
 *
 * Not a bypass and not a mode: a profile like any other, so that every stage
 * downstream keeps reading `resolved.negative` and learns nothing new. What it
 * describes is the record a film would make if it were perfect — unit gamma,
 * no fog, no orange mask, and softness at the floor, so there is no toe and no
 * shoulder but a straight line that clips at both ends the way a sensor does.
 *
 * ΔD = 3.2 is chosen rather than arbitrary: at gamma 1 it spans 10.6 stops,
 * which is the latitude of a real colour negative. A shorter range would make
 * the comparison against a stock a comparison of two different things.
 *
 * The rated speed is a formality. The ISO criterion is Dmin + 0.10, and a
 * record with no fog and no toe reaches that immediately above x0, so the
 * number it satisfies is 10 000 — declared here so the speed machinery, the
 * anchor and the ISO round-trip test all work on it unchanged, and reported in
 * the interface as "ideal" rather than as a speed anyone should believe.
 */
export const IDEAL_NEGATIVE_ID = 'neg.ideal';

const IDEAL_CURVE: CurveParameters = {
  gamma: [1, 1, 1],
  deltaD: [3.2, 3.2, 3.2],
  x0: [0, 0, 0], // positioned from the declared speed below, like every stock
  kappaT: [1e-3, 1e-3, 1e-3],
  kappaS: [1e-3, 1e-3, 1e-3],
  dMin: [0, 0, 0],
  maskDepletion: [0, 0, 0],
  balanceShift: [0, 0, 0],
};

const NO_SHIFT: Triple = [0, 0, 0];
/**
 * Tungsten layer balance (§V, eq. tungsten), as a mean-zero log-exposure tilt.
 *
 * A tungsten-balanced stock shot in daylight genuinely records a blue cast —
 * that is correct and kept. But the cast is a *relative* speed difference
 * between the layers, not a change to the mid-tone: the paper's eq. is a
 * difference between illuminants, and a difference of layer speeds carries no
 * DC term. The earlier [-0.29, 0, +0.42] had a +0.043 mean and crushed the red
 * record off its toe (mid-grey rendered [0.035, 0.110, 0.416], B/R = 12 — a
 * blue filter, not a cast). Mean-zero form keeps the cast while leaving 18%
 * grey where it belongs. The magnitude ±0.04 log is the daylight-on-tungsten
 * relative layer speed that reads as the real stock does: a subtle cool cast
 * (mid-grey B/R ≈ 1.5, about half a stop), not a blue wash. Pushed through the
 * orange mask and the print's crosstalk the tilt amplifies roughly threefold,
 * so the log shift itself stays small. See DEVIATIONS.md, finding 11.
 */
const TUNGSTEN_BALANCE: Triple = [-0.04, 0.0, 0.04];
const COLOR_BIAS: Triple = [1.0, 0.42, 0.22];
const MONO_BIAS: Triple = [1, 1, 1];
const PAN: Triple = [0.3, 0.59, 0.11];

interface Row {
  id: string;
  displayName: string;
  family: StockFamily;
  process: string;
  chemistryId: string;
  iso: number;
  fitStatus: FitStatus;
  note: string;
  green: GreenRecord;
  grain: GrainParameters;
  halation: Omit<HalationParameters, 'bias'>;
  defaultPrint: string;
  balanceShift?: Triple;
  /** Skips the per-record offsets of Appendix A: this record has no crossover. */
  idealised?: boolean;
}

const ROWS: readonly Row[] = [
  {
    id: IDEAL_NEGATIVE_ID,
    displayName: 'None — ideal negative',
    family: 'colorNegative',
    process: 'no film',
    chemistryId: 'chem.c41',
    iso: 10000,
    fitStatus: 'E',
    note: 'No stock at all: a straight line of gamma 1 with no toe, no shoulder, no fog and no mask, so that everything left in the picture is the print stock and your exposure. Its grain, halation and interlayer numbers are generic — they describe no real film, and they are the only parameters in the app that do not.',
    green: { gamma: 1, deltaD: 3.2, x0: -4.2, kappaT: 1e-3, kappaS: 1e-3, dMin: 0 },
    grain: { selwyn: 0.004, sigma1um: 1.0, chi: 0.15, zeta: 3.0, phi: 0.15, nu: [1.0, 1.0] },
    halation: { alpha: 0.15, lengthRedUm: 90, omega: 0.05 },
    defaultPrint: 'prt.2383',
    idealised: true,
  },
  {
    id: 'neg.portra160',
    displayName: 'Portra 160-type',
    family: 'colorNegative',
    process: 'C-41',
    chemistryId: 'chem.c41',
    iso: 160,
    fitStatus: 'M',
    note: 'Low contrast, high DIR activity. The gentlest of the launch stocks.',
    green: { gamma: 0.58, deltaD: 1.86, x0: -2.31, kappaT: 0.155, kappaS: 0.115, dMin: 0.9 },
    grain: { selwyn: 0.003, sigma1um: 0.85, chi: 0.12, zeta: 3.0, phi: 0.15, nu: [1.0, 1.0] },
    halation: { alpha: 0.16, lengthRedUm: 92, omega: 0.04 },
    defaultPrint: 'prt.2383',
  },
  {
    id: 'neg.portra400',
    displayName: 'Portra 400-type',
    family: 'colorNegative',
    process: 'C-41',
    chemistryId: 'chem.c41',
    iso: 400,
    fitStatus: 'M',
    note: 'The reference stock. Fitted against a full D-logE family, Wiener spectrum and MTF.',
    green: { gamma: 0.63, deltaD: 1.9, x0: -2.71, kappaT: 0.14, kappaS: 0.11, dMin: 0.92 },
    grain: { selwyn: 0.004, sigma1um: 1.05, chi: 0.16, zeta: 3.0, phi: 0.15, nu: [1.0, 1.0] },
    halation: { alpha: 0.18, lengthRedUm: 95, omega: 0.05 },
    defaultPrint: 'prt.2383',
  },
  {
    id: 'neg.gold200',
    displayName: 'Gold 200-type',
    family: 'colorNegative',
    process: 'C-41',
    chemistryId: 'chem.c41',
    iso: 200,
    fitStatus: 'P',
    note: 'Consumer stock: warmer, more contrast, coarser grain. Curves only; grain estimated.',
    green: { gamma: 0.68, deltaD: 1.78, x0: -2.41, kappaT: 0.15, kappaS: 0.098, dMin: 0.88 },
    grain: { selwyn: 0.0055, sigma1um: 1.1, chi: 0.2, zeta: 3.2, phi: 0.18, nu: [1.0, 0.92] },
    halation: { alpha: 0.21, lengthRedUm: 101, omega: 0.07 },
    defaultPrint: 'prt.2383',
  },
  {
    id: 'neg.ektar100',
    displayName: 'Ektar 100-type',
    family: 'colorNegative',
    process: 'C-41',
    chemistryId: 'chem.c41',
    iso: 100,
    fitStatus: 'M',
    note: 'The most saturated colour negative: highest gamma, finest grain, tightest halation.',
    green: { gamma: 0.72, deltaD: 2.02, x0: -2.11, kappaT: 0.128, kappaS: 0.092, dMin: 0.86 },
    grain: { selwyn: 0.0034, sigma1um: 0.8, chi: 0.1, zeta: 2.8, phi: 0.12, nu: [1.0, 1.0] },
    halation: { alpha: 0.14, lengthRedUm: 88, omega: 0.04 },
    defaultPrint: 'prt.2393',
  },
  {
    id: 'neg.superia400',
    displayName: 'Superia 400-type',
    family: 'colorNegative',
    process: 'C-41',
    chemistryId: 'chem.c41',
    iso: 400,
    fitStatus: 'P',
    note: 'Distinct green rendering. Fitted at normal process only.',
    green: { gamma: 0.65, deltaD: 1.84, x0: -2.71, kappaT: 0.145, kappaS: 0.104, dMin: 0.94 },
    grain: { selwyn: 0.0042, sigma1um: 1.02, chi: 0.18, zeta: 3.0, phi: 0.16, nu: [1.0, 0.96] },
    halation: { alpha: 0.19, lengthRedUm: 97, omega: 0.06 },
    defaultPrint: 'prt.3513',
  },
  {
    id: 'neg.v3_500t',
    displayName: 'Vision3 500T-type',
    family: 'colorNegative',
    process: 'ECN-2',
    chemistryId: 'chem.ecn2',
    iso: 500,
    fitStatus: 'M',
    note: 'Tungsten balanced. Shot under daylight without correction the cast changes character with luminance, because blue is driven up its curve while red sits in its toe.',
    green: { gamma: 0.55, deltaD: 2.06, x0: -2.81, kappaT: 0.168, kappaS: 0.13, dMin: 0.96 },
    grain: { selwyn: 0.005, sigma1um: 1.15, chi: 0.17, zeta: 3.1, phi: 0.14, nu: [1.0, 1.0] },
    halation: { alpha: 0.05, lengthRedUm: 86, omega: 0.01 },
    defaultPrint: 'prt.2383',
    balanceShift: TUNGSTEN_BALANCE,
  },
  {
    id: 'rev.velvia50',
    displayName: 'Velvia 50-type',
    family: 'transparency',
    process: 'E-6',
    chemistryId: 'chem.e6',
    iso: 50,
    fitStatus: 'M',
    note: 'Reversal: gamma is negative and the same equations produce a positive image. Viewed directly, so it defaults to the bypass print.',
    green: { gamma: -1.95, deltaD: 3.1, x0: -1.8, kappaT: 0.09, kappaS: 0.14, dMin: 0.1 },
    grain: { selwyn: 0.009, sigma1um: 0.95, chi: 0.14, zeta: 2.9, phi: 0.35, nu: [1.0, 0.8] },
    halation: { alpha: 0.1, lengthRedUm: 80, omega: 0.03 },
    defaultPrint: 'prt.bypass',
  },
  {
    id: 'rev.provia100',
    displayName: 'Provia 100F-type',
    family: 'transparency',
    process: 'E-6',
    chemistryId: 'chem.e6',
    iso: 100,
    fitStatus: 'P',
    note: 'The even-handed transparency. Curves only.',
    green: { gamma: -1.72, deltaD: 2.95, x0: -2.1, kappaT: 0.105, kappaS: 0.15, dMin: 0.09 },
    grain: { selwyn: 0.008, sigma1um: 0.98, chi: 0.15, zeta: 2.9, phi: 0.35, nu: [1.0, 0.84] },
    halation: { alpha: 0.11, lengthRedUm: 82, omega: 0.03 },
    defaultPrint: 'prt.bypass',
  },
  {
    id: 'mono.trix400',
    displayName: 'Tri-X 400-type',
    family: 'monochrome',
    process: 'B&W',
    chemistryId: 'chem.bw',
    iso: 400,
    fitStatus: 'M',
    note: 'One silver image, so the grain is neutral rather than coloured, and it is the coarsest in the bundle.',
    green: { gamma: 0.62, deltaD: 1.92, x0: -2.71, kappaT: 0.16, kappaS: 0.2, dMin: 0.22 },
    grain: { selwyn: 0.017, sigma1um: 1.55, chi: 0.28, zeta: 3.4, phi: 1.0, nu: [1.0, 0.45] },
    halation: { alpha: 0.12, lengthRedUm: 90, omega: 0.05 },
    defaultPrint: 'prt.2383',
  },
  {
    id: 'mono.hp5',
    displayName: 'HP5 Plus-type',
    family: 'monochrome',
    process: 'B&W',
    chemistryId: 'chem.bw',
    iso: 400,
    fitStatus: 'M',
    note: 'The smallest well-formedness margin in the bundle: a long shoulder needs a large kappa_s, so this is the stock the constraint binds on first when you push development.',
    green: { gamma: 0.58, deltaD: 1.88, x0: -2.71, kappaT: 0.17, kappaS: 0.215, dMin: 0.2 },
    grain: { selwyn: 0.015, sigma1um: 1.48, chi: 0.26, zeta: 3.3, phi: 1.0, nu: [1.0, 0.48] },
    halation: { alpha: 0.13, lengthRedUm: 93, omega: 0.06 },
    defaultPrint: 'prt.2383',
  },
];

export const NEGATIVES: readonly NegativeProfile[] = ROWS.map((row) => ({
  id: row.id,
  displayName: row.displayName,
  family: row.family,
  process: row.process,
  chemistryId: row.chemistryId,
  iso: row.iso,
  fitStatus: row.fitStatus,
  note: row.note,
  /** Published x0 for reference; the shipped curve uses the speed-corrected one. */
  publishedX0: row.green.x0,
  curve: row.idealised
    ? { ...IDEAL_CURVE, x0: triFill(speedCorrectedX0(row.green, row.iso)) }
    : expandCurve(
        { ...row.green, x0: speedCorrectedX0(row.green, row.iso) },
        row.family,
        row.balanceShift ?? NO_SHIFT,
      ),
  grain: row.grain,
  halation: {
    ...row.halation,
    bias: row.family === 'monochrome' ? MONO_BIAS : COLOR_BIAS,
  },
  interlayer: INTERLAYER[row.family],
  defaultPrint: row.defaultPrint,
  panWeights: row.family === 'monochrome' ? PAN : null,
  aimIlluminantK: row.balanceShift ? 3200 : 5500,
}));

/** The illuminant the daylight stocks are balanced for. */
export const DAYLIGHT_AIM_K = 5500;

const BY_ID = new Map(NEGATIVES.map((n) => [n.id, n]));

export function negativeById(id: string): NegativeProfile {
  const n = BY_ID.get(id);
  if (!n) throw new Error(`unknown negative stock '${id}'`);
  return n;
}

/** Scattering length ratios, red-relative (§XII). */
export const HALATION_LENGTH_RATIOS: Triple = [1.0, 0.62, 0.44];
