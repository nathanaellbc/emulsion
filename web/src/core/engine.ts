/**
 * The print-engine dispatch, on the host.
 *
 * `chain.ts` remains the calculated model, stage for stage — it is what the
 * tests hold against the document's published values, and it must not learn
 * about LUTs. This file sits above it: same scene-linear preamble and
 * negative-side stages 1–3, and at stage 4 either the model continues or the
 * measured stock takes over.
 *
 * The LUT branch mirrors what the GPU's chain shader does, instruction for
 * instruction: the printer lights fold into the negative as a density
 * offset, the Cineon encode anchors the stock's own neutral at code 445, and
 * the cube is sampled trilinearly in the same node order the 3D texture
 * uploads in. Divergence between this and the shader is a defect in one of
 * them, never a tolerance.
 */

import {
  applySurround,
  evaluateLogExposure,
  evaluateLogExposureStages,
  sceneLogExposure,
  negativeDensity,
} from './chain';
import { encodeCineon } from './cineon';
import { sampleCube, type CubeLut } from './cube';
import { M_SRGB_TO_AP1 } from './colorspace';
import type { ResolvedParameters } from './resolve';
import { matMulVec, triMap, type Triple } from './triple';

/** Rec.709's display gamma, as the LUT files encode their output. */
const REC709_GAMMA = 2.4;

/**
 * Stages 4–9 through the measured stock. Returns display-linear Y in the
 * same convention the model returns — AP1-treated, with the output matrix
 * still to come — so everything downstream of the print is engine-blind.
 */
function evaluateLutPrint(D: Triple, p: ResolvedParameters, lut: CubeLut): Triple {
  // Stage 5 — the printer lights and master density, as a density offset on
  // the negative. The measurement carries its own balance (the Cineon anchor
  // below), so only the user's lights appear here.
  const dEff = triMap(D, (d, c) => d - p.printExposureOffset[c]);

  // The Cineon encode: the stock's neutral at code 445, five hundred codes
  // per density unit, clamped to the table's domain.
  const u = encodeCineon(dEff, p.printLut!.anchor);

  // The measured response, decoded from Rec.709 gamma 2.4 into linear, then
  // into the working space the model's output matrix expects.
  const srgb = sampleCube(lut, u);
  const linear = triMap(srgb, (v) => Math.pow(Math.max(v, 0), REC709_GAMMA));
  return matMulVec(M_SRGB_TO_AP1, linear);
}

/**
 * Subtractive grading, on the print's dye amounts.
 *
 * The CMY sliders are dye-density offsets, and a dye-density offset is
 * exactly a transmittance multiply in linear light: cyan Δ density is
 * red × 10^−Δ. The density master has Color Finale's two modes: 'suppress'
 * adds neutral density (a denser, quieter print), 'multiply' thins the dyes
 * — a dye scale of k is transmittance^k, so the print brightens as it thins.
 * Both are neutral-preserving, and both act identically on either engine's
 * output because they sit after the print, where the dyes exist.
 */
function applySubtractive(Y: Triple, p: ResolvedParameters): Triple {
  const s = p.subtractive;
  let out: Triple = [
    Y[0] * Math.pow(10, -s.cyan),
    Y[1] * Math.pow(10, -s.magenta),
    Y[2] * Math.pow(10, -s.yellow),
  ];
  if (s.density > 1e-4) {
    if (s.densityMode === 'suppress') {
      const d = Math.pow(10, -0.6 * s.density);
      out = [out[0] * d, out[1] * d, out[2] * d];
    } else {
      const k = 1 - s.density;
      out = [Math.pow(out[0], k), Math.pow(out[1], k), Math.pow(out[2], k)];
    }
  }
  return out;
}

/**
 * The full chain with the engine choice applied. `lut` is the loaded cube
 * for the resolved stock; when the engine is 'lut' and it is missing, the
 * model renders — a LUT that has not finished loading is a frame or two of
 * model, never a broken frame.
 */
export function evaluateLogExposureWithEngine(
  logExposure: Triple,
  p: ResolvedParameters,
  lut: CubeLut | null,
): Triple {
  if (p.bypass) return evaluateLogExposure(logExposure, p);
  if (p.printEngine === 'lut' && p.printLut && lut) {
    const D = negativeDensity(logExposure, p);
    const Y = evaluateLutPrint(D, p, lut);
    return applySurround(applySubtractive(Y, p), p);
  }
  // The model's stages end before the surround, so the subtractive grade —
  // a print-dye operation — sits between the print and the viewing
  // condition on both engines.
  const Y = evaluateLogExposureStages(logExposure, p);
  return applySurround(applySubtractive(Y, p), p);
}

/**
 * The scene-linear entry point with the engine applied — the one the app and
 * the export path call.
 */
export function evaluateSceneLinearWithEngine(
  sceneLinear: Triple,
  p: ResolvedParameters,
  lut: CubeLut | null,
): Triple {
  return evaluateLogExposureWithEngine(sceneLogExposure(sceneLinear, p), p, lut);
}
