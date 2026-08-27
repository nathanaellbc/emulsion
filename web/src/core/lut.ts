/**
 * Baking the chain to a 3D LUT (§XV-E).
 *
 * The design document's module B bakes the pointwise chain into a 45³ table and
 * evaluates that on the GPU. This project evaluates the equations directly
 * instead, which is why grain, halation and interlayer inhibition exist here at
 * all — none of the three is expressible as a lookup. So the LUT is not the
 * renderer; it is an export, for taking a look into a grading suite.
 *
 * That distinction is the whole reason the header is as loud as it is. A film
 * emulation delivered as a LUT is a film emulation with its spatial and
 * stochastic stages removed, and the removal is invisible in the file. Anyone
 * downstream deserves to be told, in the artifact itself, which parts of the
 * picture did not come with it.
 *
 * Domain is ACEScct in AP1 primaries — a standard log encoding with an exact
 * inverse and a linear segment through zero, so the deep toe survives being
 * sampled on a uniform grid. A linear-light cube would spend most of its nodes
 * above middle grey and almost none in the shadows, where the toe is.
 */

import { develop, developIsIdentity } from './develop';
import { evaluateLogExposureWithEngine } from './engine';
import { safeLog10 } from './math';
import type { CubeLut } from './cube';
import type { ResolvedParameters } from './resolve';
import { RECORDS, matMulVec, triFill, type Triple } from './triple';

export const DEFAULT_LUT_SIZE = 33;
const MIN_LUT_SIZE = 9;
const MAX_LUT_SIZE = 129;

/** ACEScct constants (Academy S-2016-001). */
const CCT_A = 10.5402377416545;
const CCT_B = 0.0729055341958355;
const CCT_BREAK_LINEAR = 0.0078125;
const CCT_BREAK_LOG = 0.155251141552511;

export function linearToAcesCct(v: number): number {
  if (v <= CCT_BREAK_LINEAR) return CCT_A * v + CCT_B;
  return (Math.log2(v) + 9.72) / 17.52;
}

export function acesCctToLinear(v: number): number {
  if (v <= CCT_BREAK_LOG) return (v - CCT_B) / CCT_A;
  return Math.pow(2, v * 17.52 - 9.72);
}

function oetf(v: number): number {
  const x = Math.min(Math.max(v, 0), 1);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/**
 * One LUT node: ACEScct AP1 in, display-encoded output out.
 *
 * White balance and the exposure anchor are baked, because they are part of
 * the look. The source-primaries matrix is not: the LUT declares an AP1
 * input, and converting into it is the grading system's job — baking it
 * would make the file silently wrong for footage from any other camera.
 *
 * The engine choice rides along: an edit rendering through the measured stock
 * bakes the measured stock, so the exported file matches the screen.
 */
export function lutOutputFor(cct: Triple, p: ResolvedParameters, lut: CubeLut | null = null): Triple {
  const linear = RECORDS.map((c) => acesCctToLinear(cct[c])) as unknown as Triple;
  let e = matMulVec(p.whiteBalance, linear);
  e = RECORDS.map((c) => Math.max(e[c] * p.exposureGain, 0)) as unknown as Triple;
  // The camera develop is baked with the white balance it sits beside: it is
  // scene-side, part of the look the way exposure is. It is applied through
  // `chain.ts`'s own operator so the bake and the render cannot drift.
  if (!developIsIdentity(p.camera)) e = develop(e, p.camera);
  if (p.monochrome) {
    e = triFill(p.panWeights[0] * e[0] + p.panWeights[1] * e[1] + p.panWeights[2] * e[2]);
  }
  const logE = RECORDS.map((c) => safeLog10(e[c]) + p.anchorShift) as unknown as Triple;
  const Y = evaluateLogExposureWithEngine(logE, p, lut);
  const rgb = matMulVec(p.outputMatrix, Y);
  return RECORDS.map((c) => oetf(rgb[c])) as unknown as Triple;
}

/**
 * Trilinear interpolation, exactly as a grading system applies a .cube. Used to
 * measure what the file will actually do, rather than what the grid implies.
 */
function sampleGrid(data: Float64Array, size: number, cct: Triple): Triple {
  const pos = RECORDS.map((c) => Math.min(Math.max(cct[c], 0), 1) * (size - 1));
  const i0 = pos.map(Math.floor);
  const f = pos.map((v, k) => v - i0[k]!);
  const at = (r: number, g: number, b: number, c: number) => {
    const ri = Math.min(r, size - 1);
    const gi = Math.min(g, size - 1);
    const bi = Math.min(b, size - 1);
    return data[3 * (ri + size * (gi + size * bi)) + c]!;
  };
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let dr = 0; dr < 2; dr++)
      for (let dg = 0; dg < 2; dg++)
        for (let db = 0; db < 2; db++) {
          acc +=
            (dr ? f[0]! : 1 - f[0]!) *
            (dg ? f[1]! : 1 - f[1]!) *
            (db ? f[2]! : 1 - f[2]!) *
            at(i0[0]! + dr, i0[1]! + dg, i0[2]! + db, c);
        }
    out[c] = acc;
  }
  return out as unknown as Triple;
}

function buildGrid(p: ResolvedParameters, size: number, lut: CubeLut | null): Float64Array {
  const data = new Float64Array(size * size * size * 3);
  const step = 1 / (size - 1);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = lutOutputFor([r * step, g * step, b * step], p, lut);
        data[i++] = out[0];
        data[i++] = out[1];
        data[i++] = out[2];
      }
    }
  }
  return data;
}

/**
 * Worst deviation, in output units, between the interpolated table and the
 * chain it was baked from — swept densely along the tone scale and off the
 * neutral axis, because that is where a film curve is steep and where a sparse
 * probe set walks straight past the error.
 *
 * The sweep runs from four stops under the deepest useful shadow to three above
 * white, which is the range a grading system will actually push through it.
 */
export function measureCubeError(p: ResolvedParameters, size: number, lut: CubeLut | null = null): number {
  const data = buildGrid(p, size, lut);
  const tints: Triple[] = [
    [1, 1, 1],
    [1.3, 1, 0.75],
    [0.8, 1, 1.25],
    [1, 0.7, 0.5],
    [0.6, 1.1, 1.4],
  ];
  let worst = 0;
  const STEPS = 240;
  for (let i = 0; i <= STEPS; i++) {
    const linear = 5e-4 * Math.pow(10, (4.2 * i) / STEPS);
    for (const t of tints) {
      const cct = RECORDS.map((c) => linearToAcesCct(linear * t[c])) as unknown as Triple;
      const approx = sampleGrid(data, size, cct);
      const exact = lutOutputFor(cct, p, lut);
      for (const c of RECORDS) worst = Math.max(worst, Math.abs(approx[c] - exact[c]));
    }
  }
  return worst;
}

export interface CubeOptions {
  size?: number;
  title?: string;
  /** Filled in by `bakeCube`, which measures before it writes the header. */
  accuracy?: { worstError: number; degraded: boolean };
  /** The loaded measured stock, when the edit renders through it. */
  engineLut?: CubeLut | null;
}

/** One code value at 8 bits. Below this the table is indistinguishable from the chain. */
const ERROR_TOLERANCE = 1 / 255;
/**
 * Grids to try, in order, stopping at the first that reproduces the chain to
 * within one code value. Measured, not assumed: a gentle colour negative meets
 * it at 85³, while a reversal stock stays coarser than the tolerance at every
 * size a .cube can carry, which the header then says out loud. 129³ is 2.1M
 * nodes — past the largest grid most grading systems accept, so it is the last
 * one tried.
 */
const CANDIDATE_SIZES = [33, 65, 85, 129];

export interface BakedCube {
  cube: string;
  size: number;
  /** Measured worst deviation from the exact chain, in output units. */
  worstError: number;
  /** True when even the finest grid could not meet the tolerance. */
  degraded: boolean;
}

/**
 * Bakes at the coarsest grid that still reproduces the chain to within a code
 * value, measuring rather than assuming.
 *
 * A gentle colour negative meets the tolerance at 85³. A reversal stock puts
 * |gamma| near 2 and a hard toe inside about four nodes, and stays coarser than
 * one code value at every grid a .cube can carry — which is a fact about lookup
 * tables, not about this implementation, and the header says so instead of
 * shipping a quiet approximation.
 */
export function bakeCube(p: ResolvedParameters, opts: CubeOptions = {}): BakedCube {
  const lut = opts.engineLut ?? null;
  if (opts.size !== undefined) {
    const worstError = measureCubeError(p, opts.size, lut);
    return {
      cube: generateCubeLUT(p, { ...opts, accuracy: { worstError, degraded: worstError > ERROR_TOLERANCE } }),
      size: opts.size,
      worstError,
      degraded: worstError > ERROR_TOLERANCE,
    };
  }

  let chosen = CANDIDATE_SIZES[0]!;
  let worstError = Infinity;
  for (const size of CANDIDATE_SIZES) {
    chosen = size;
    worstError = measureCubeError(p, size, lut);
    if (worstError <= ERROR_TOLERANCE) break;
  }
  const degraded = worstError > ERROR_TOLERANCE;
  return {
    cube: generateCubeLUT(p, { ...opts, size: chosen, accuracy: { worstError, degraded } }),
    size: chosen,
    worstError,
    degraded,
  };
}

export function generateCubeLUT(p: ResolvedParameters, opts: CubeOptions = {}): string {
  const lut = opts.engineLut ?? null;
  const size = opts.size ?? DEFAULT_LUT_SIZE;
  if (!Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_SIZE) {
    throw new RangeError(
      `LUT size ${size} is outside ${MIN_LUT_SIZE}–${MAX_LUT_SIZE}: below that the toe cannot be carried by interpolation`,
    );
  }

  const r = p.recipe;
  const title = opts.title ?? `${p.negative.displayName} on ${p.print.displayName}`;
  const lines: string[] = [
    `# EMULSION — ${p.negative.displayName} on ${p.print.displayName}`,
    '#',
    '# INPUT   ACEScct, AP1 primaries. Transform your footage into it first;',
    '#         applied in any other encoding this file is silently wrong.',
    '# OUTPUT  Display P3, sRGB-style transfer, as the application shows it.',
    '#',
    '# NOT IN THIS FILE. A 3D LUT is a pointwise object and three of the stages',
    '# that make this look are not pointwise, so they cannot be baked and are',
    '# not present below:',
    '#   grain       — stochastic, formed in the negative density (§XI)',
    '#   halation    — spatial, summed in linear exposure before the curve (§XII)',
    '#   interlayer  — spatial, the DIR adjacency and inter-image effect (§VIII)',
    '# What is baked is the pointwise chain: layer balance, characteristic curve,',
    '# mask depletion, printing density, printer lights, print curve, silver',
    '# retention, neutral axis and the display transform.',
    '#',
    `# negative     ${r.negativeId}`,
    `# print        ${r.printId}`,
    `# chemistry    ${r.chemistryId}   activity A = ${p.developmentActivity.toFixed(4)}`,
    `# printer      R ${r.printing.printerLightR} G ${r.printing.printerLightG} B ${r.printing.printerLightB} points, master ${r.printing.printDensity}`,
    `# aim density  ${p.print.aimDensity.map((v) => v.toFixed(2)).join(' / ')} (${p.print.aimSource})`,
    `# exposure     ${r.capture.exposureCompensation.toFixed(2)} EV at ${r.capture.whiteBalanceTempK} K`,
    `# recipe hash  ${p.recipeHash}`,
  ];

  // The measured-accuracy disclosure. A 3D LUT of a film chain is an
  // approximation, and how good an approximation depends on where the stock's
  // curve is steep relative to where the grid's nodes fall — which nothing in
  // the file otherwise shows. `bakeCube` measures it against the exact chain
  // and stamps it here, so the number is the measured one, not a claim.
  if (opts.accuracy) {
    const cv = opts.accuracy.worstError * 255;
    lines.push(
      '#',
      `# ACCURACY  Worst deviation from the exact chain, trilinearly interpolated`,
      `#           over a dense sweep of the working range: ${cv.toFixed(2)}/255 code values.`,
    );
    if (opts.accuracy.degraded) {
      lines.push(
        `#           This exceeds one code value: this stock's curve is too steep`,
        `#           for any grid a .cube can carry. Reproduction is coarser than`,
        `#           the tolerance — expect banding in smooth gradients.`,
      );
    }
  }

  lines.push(
    '',
    `TITLE "${title.replace(/"/g, "'")}"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  );

  // Red varies fastest, then green, then blue — the .cube ordering.
  const step = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let rr = 0; rr < size; rr++) {
        const out = lutOutputFor([rr * step, g * step, b * step], p, lut);
        lines.push(`${out[0].toFixed(6)} ${out[1].toFixed(6)} ${out[2].toFixed(6)}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}
