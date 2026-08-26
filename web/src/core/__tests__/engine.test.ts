import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultRecipe } from '../recipe';
import { resolve, type ResolvedParameters } from '../resolve';
import { evaluateSceneLinear } from '../chain';
import { evaluateSceneLinearWithEngine } from '../engine';
import { parseCube, sampleCube, type CubeLut } from '../cube';
import { encodeCineon, CINEON_GREY_NORMALISED } from '../cineon';
import { NEGATIVES } from '../profiles/negatives';
import { M_SRGB_TO_AP1 } from '../colorspace';
import { matMulVec, triMap, type Triple } from '../triple';

const lutPath = (file: string) => fileURLToPath(new URL(`../../../public/luts/${file}`, import.meta.url));
const LUTS: Record<string, CubeLut> = {
  'prt.2383': parseCube(readFileSync(lutPath('kodak-2383-d65.cube'), 'utf8')),
  'prt.2393': parseCube(readFileSync(lutPath('kodak-2393-d65.cube'), 'utf8')),
  'prt.3513': parseCube(readFileSync(lutPath('fuji-3513-d65.cube'), 'utf8')),
};

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;

function resolved(over: Partial<ReturnType<typeof defaultRecipe>> = {}): ResolvedParameters {
  return resolve({ ...defaultRecipe(), ...over }, ctx);
}

/** The engine's full path, carried through the same display tail the GPU uses. */
function display(scene: Triple, p: ResolvedParameters, lut: CubeLut | null): Triple {
  const y = evaluateSceneLinearWithEngine(scene, p, lut);
  const rgb = matMulVec(p.outputMatrix, y);
  return triMap(rgb, encodeSrgb);
}

function encodeSrgb(v: number): number {
  const x = Math.min(Math.max(v, 0), 1);
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

describe('the Cineon encode', () => {
  it('anchors every stock\'s own neutral at code 445', () => {
    for (const n of NEGATIVES) {
      const p = resolved({ negativeId: n.id, printEngine: 'model' });
      if (!p.printLut) continue;
      const u = encodeCineon(p.printLut.anchor, p.printLut.anchor);
      for (const c of [0, 1, 2]) expect(u[c]).toBeCloseTo(CINEON_GREY_NORMALISED, 12);
    }
  });

  it('keeps a full scene inside the table domain, on every stock', () => {
    for (const n of NEGATIVES) {
      const p = resolved({ negativeId: n.id });
      if (!p.printLut) continue;
      const lut = LUTS[p.printLut.id];
      if (!lut) continue;
      for (const scene of [0.005, 0.05, 0.18, 0.9, 4.0]) {
        const y = evaluateSceneLinearWithEngine([scene, scene, scene], p, lut);
        // Matrix arithmetic leaves float dust at the gamut boundary; the
        // display encode clamps it. Anything beyond dust is a real fault.
        expect(y.every((v) => Number.isFinite(v) && v > -1e-9)).toBe(true);
      }
    }
  });

  it('inverts exactly', () => {
    const p = resolved();
    const anchor = p.printLut!.anchor;
    const d: Triple = [1.2, 1.5, 1.9];
    const u = encodeCineon(d, anchor);
    const back = u.map(
      (v, c) => (v * 1023 - 445) / 500 + anchor[c]!,
    ) as unknown as Triple;
    for (const c of [0, 1, 2]) expect(back[c]).toBeCloseTo(d[c]!, 10);
  });
});

describe('the measured print engine', () => {
  it('a correctly exposed neutral lands on the measured stock neutral', () => {
    const p = resolved();
    const lut = LUTS['prt.2383']!;
    // The chain's output must equal the table sampled at the anchor — the
    // whole encode exists to make that one statement true.
    const expected = sampleCube(lut, encodeCineon(p.printLut!.anchor, p.printLut!.anchor));
    const y = evaluateSceneLinearWithEngine([0.18, 0.18, 0.18], p, lut);
    const throughMatrix = matMulVec(M_SRGB_TO_AP1, triMap(expected, (v) => Math.pow(v, 2.4)));
    for (const c of [0, 1, 2]) expect(y[c]).toBeCloseTo(throughMatrix[c]!, 1e-9);
  });

  it('a brighter scene prints brighter — the polarity of a negative', () => {
    const p = resolved();
    const lut = LUTS['prt.2383']!;
    const dark = display([0.02, 0.02, 0.02], p, lut);
    const bright = display([2.5, 2.5, 2.5], p, lut);
    for (const c of [0, 1, 2]) expect(bright[c]!).toBeGreaterThan(dark[c]!);
  });

  it('printer lights move the print the way the model does', () => {
    const lut = LUTS['prt.2383']!;
    const p0 = resolved();
    const warmer = resolved({ printing: { ...defaultRecipe().printing, printerLightR: 6 } });
    const a = display([0.18, 0.18, 0.18], p0, lut);
    const b = display([0.18, 0.18, 0.18], warmer, lut);
    // The model's own convention, tested the same way: more red printing
    // light means more red exposure, which for a print stock means less red
    // in the result.
    expect(b[0]).toBeLessThan(a[0]);
    // The model could assert green unmoved to 1e-6 because its lights act
    // after its crosstalk matrix. The measurement's lights act *through* the
    // stock's real cross-terms — the green dye answers the red exposure a
    // little — so green moves, by much less than red does. That difference is
    // the measurement being more honest than the model, not drift.
    const redMove = Math.abs(a[0]! - b[0]!);
    const greenMove = Math.abs(a[1]! - b[1]!);
    expect(greenMove).toBeLessThan(redMove);
    expect(greenMove).toBeLessThan(0.06);
  });

  it('print density darkens without moving the film', () => {
    const lut = LUTS['prt.2383']!;
    const p0 = resolved();
    const denser = resolved({ printing: { ...defaultRecipe().printing, printDensity: 12 } });
    const a = display([0.18, 0.18, 0.18], p0, lut)[1];
    const b = display([0.18, 0.18, 0.18], denser, lut)[1];
    expect(b).toBeLessThan(a);
  });

  it('the engine choice degrades to the model when the LUT is not loaded yet', () => {
    const p = resolved();
    const withLut = evaluateSceneLinearWithEngine([0.4, 0.3, 0.2], p, LUTS['prt.2383']!);
    const without = evaluateSceneLinearWithEngine([0.4, 0.3, 0.2], p, null);
    const model = evaluateSceneLinear([0.4, 0.3, 0.2], p);
    expect(without).toEqual(model);
    expect(withLut).not.toEqual(model);
  });

  it('a stock without a measurement always renders through the model', () => {
    const p = resolved({ printId: 'prt.3521' });
    expect(p.printEngine).toBe('model');
    expect(p.printLut).toBeNull();
  });

  it('the bypass scan ignores the engine choice', () => {
    const p = resolved({ printId: 'prt.bypass' });
    expect(p.printEngine).toBe('model');
    const y = evaluateSceneLinearWithEngine([0.3, 0.3, 0.3], p, LUTS['prt.2383']!);
    expect(y).toEqual(evaluateSceneLinear([0.3, 0.3, 0.3], p));
  });

  it('each measured stock renders a distinct neutral cast', () => {
    // The three measurements disagree with each other — that disagreement is
    // the stocks' character, and a bug that collapsed them to one response
    // would show here first.
    const greys = Object.entries(LUTS).map(([id, lut]) => {
      const p = resolved({ printId: id });
      return display([0.18, 0.18, 0.18], p, lut);
    });
    for (let i = 0; i < greys.length; i++) {
      for (let j = i + 1; j < greys.length; j++) {
        const d = Math.max(...greys[i]!.map((v, c) => Math.abs(v - greys[j]![c]!)));
        expect(d).toBeGreaterThan(0.004);
      }
    }
  });

  it('each print illuminant of a stock renders distinctly', () => {
    // The illuminant is a measurement, not a tint: D55 and D65 are different
    // tables, and a grey through them lands in different places.
    const d55 = parseCube(readFileSync(lutPath('kodak-2383-d55.cube'), 'utf8'));
    const d65 = LUTS['prt.2383']!;
    const p = resolved({ printIlluminant: 'D55' });
    expect(p.printLut!.illuminant).toBe('D55');
    expect(p.printLut!.illuminants).toEqual(['D55', 'D60', 'D65']);
    const a = display([0.5, 0.5, 0.5], p, d55);
    const b = display([0.5, 0.5, 0.5], { ...p, recipe: { ...p.recipe, printIlluminant: 'D65' } }, d65);
    const d = Math.max(...a.map((v, c) => Math.abs(v - b[c]!)));
    expect(d).toBeGreaterThan(0.002);
  });

  it('2393 has a single-illuminant measurement', () => {
    const p = resolved({ printId: 'prt.2393' });
    expect(p.printLut!.illuminants).toEqual(['D65']);
  });
});

describe('subtractive grading', () => {
  it('does nothing at its defaults', () => {
    const p0 = resolved();
    const p1 = resolved({
      subtractive: { cyan: 0, magenta: 0, yellow: 0, density: 0, densityMode: 'suppress' },
    });
    const a = display([0.4, 0.3, 0.2], p0, LUTS['prt.2383']!);
    const b = display([0.4, 0.3, 0.2], p1, LUTS['prt.2383']!);
    expect(a).toEqual(b);
  });

  it('adding cyan removes red, and only red moves most', () => {
    const lut = LUTS['prt.2383']!;
    const p0 = resolved();
    const p1 = resolved({
      subtractive: { cyan: 0.3, magenta: 0, yellow: 0, density: 0, densityMode: 'suppress' },
    });
    const a = display([0.35, 0.3, 0.25], p0, lut);
    const b = display([0.35, 0.3, 0.25], p1, lut);
    expect(b[0]).toBeLessThan(a[0]!);
    const redMove = a[0]! - b[0]!;
    expect(redMove).toBeGreaterThan(Math.abs(a[1]! - b[1]!) * 2);
    expect(redMove).toBeGreaterThan(Math.abs(a[2]! - b[2]!) * 2);
  });

  it('equal CMY scales a grey by one uniform factor', () => {
    const lut = LUTS['prt.2383']!;
    const p0 = resolved();
    const p1 = resolved({
      subtractive: { cyan: 0.15, magenta: 0.15, yellow: 0.15, density: 0, densityMode: 'suppress' },
    });
    const a = evaluateSceneLinearWithEngine([0.3, 0.3, 0.3], p0, lut);
    const b = evaluateSceneLinearWithEngine([0.3, 0.3, 0.3], p1, lut);
    // The stock's own neutral cast is untouched; every record carries the
    // same 10^-0.15 dye factor.
    const factor = b[0]! / a[0]!;
    expect(factor).toBeCloseTo(Math.pow(10, -0.15), 9);
    expect(b[1]! / a[1]!).toBeCloseTo(factor, 9);
    expect(b[2]! / a[2]!).toBeCloseTo(factor, 9);
  });

  it('suppress darkens; multiply brightens toward paper', () => {
    const lut = LUTS['prt.2383']!;
    const base = display([0.35, 0.35, 0.35], resolved(), lut);
    const suppressed = display(
      [0.35, 0.35, 0.35],
      resolved({ subtractive: { cyan: 0, magenta: 0, yellow: 0, density: 1, densityMode: 'suppress' } }),
      lut,
    );
    const multiplied = display(
      [0.35, 0.35, 0.35],
      resolved({ subtractive: { cyan: 0, magenta: 0, yellow: 0, density: 1, densityMode: 'multiply' } }),
      lut,
    );
    for (const c of [0, 1, 2]) {
      expect(suppressed[c]!).toBeLessThan(base[c]!);
      expect(multiplied[c]!).toBeGreaterThan(base[c]!);
    }
  });

  it('grades the calculated engine identically in direction', () => {
    const p0 = resolved({ printEngine: 'model' });
    const p1 = resolved({
      printEngine: 'model',
      subtractive: { cyan: 0.3, magenta: 0, yellow: 0, density: 0, densityMode: 'suppress' },
    });
    const a = display([0.35, 0.3, 0.25], p0, null);
    const b = display([0.35, 0.3, 0.25], p1, null);
    expect(b[0]).toBeLessThan(a[0]!);
  });
});

describe('grain response and color variation', () => {
  it('the response bias is centred at the stock and swings both ways', () => {
    expect(resolved().grain.responseGamma).toBeCloseTo(1, 12);
    expect(resolved({ grain: { ...defaultRecipe().grain, response: 1 } }).grain.responseGamma).toBeCloseTo(0.25, 12);
    expect(resolved({ grain: { ...defaultRecipe().grain, response: -1 } }).grain.responseGamma).toBeCloseTo(4, 12);
  });

  it('color variation at zero collapses the records to one silver field', () => {
    const p = resolved({ grain: { ...defaultRecipe().grain, colorMix: 0 } });
    const l = p.grain.cholesky;
    // choleskyEqui(1): every record reads the same field.
    expect(l[1]![0]).toBe(1);
    expect(l[2]![0]).toBe(1);
    expect(l[1]![1]).toBe(0);
    expect(l[2]![2]).toBe(0);
  });

  it('color variation at full restores the stock chroma grain', () => {
    const p = resolved({ grain: { ...defaultRecipe().grain, colorMix: 1 } });
    // The stock's own correlation is strictly below unity, so the records
    // carry distinct fields again.
    expect(p.grain.cholesky[1]![0]).toBeLessThan(1);
    expect(p.grain.cholesky[1]![1]).toBeGreaterThan(0);
  });
});
