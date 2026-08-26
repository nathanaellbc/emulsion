/**
 * Baking the pointwise chain to a .cube.
 *
 * The design document's module B bakes `PointwiseChain.evaluate` into a 45³
 * LUT; this is that, emitted as a file a colourist can use. What matters in the
 * tests is the honesty of the artifact: that it reproduces the chain at its
 * nodes, that a 33³ grid is fine enough that interpolation between them does
 * not visibly drift, and that the header says out loud which stages could not
 * come with it — a LUT is a pointwise object, and three of our stages are not.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LUT_SIZE,
  acesCctToLinear,
  bakeCube,
  generateCubeLUT,
  linearToAcesCct,
  lutOutputFor,
  measureCubeError,
} from '../lut';
import { defaultRecipe } from '../recipe';
import { resolve } from '../resolve';
import { IDEAL_NEGATIVE_ID } from '../profiles/negatives';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;
// This suite measures the calculated chain's own bake; the measured-stock
// engine is tested in engine.test.ts.
const params = resolve({ ...defaultRecipe(), printEngine: 'model' }, ctx);

function parse(cube: string) {
  const lines = cube.split('\n');
  const size = Number(lines.find((l) => l.startsWith('LUT_3D_SIZE'))!.split(/\s+/)[1]);
  const data = lines
    .filter((l) => /^-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s*$/.test(l))
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
  return { size, data };
}

/** Trilinear sample, exactly as a LUT box would apply it. */
function sample(data: [number, number, number][], size: number, rgb: [number, number, number]) {
  const pos = rgb.map((v) => Math.min(Math.max(v, 0), 1) * (size - 1));
  const i0 = pos.map((v) => Math.floor(v));
  const f = pos.map((v, k) => v - i0[k]!);
  const at = (r: number, g: number, b: number) => {
    const ri = Math.min(r, size - 1);
    const gi = Math.min(g, size - 1);
    const bi = Math.min(b, size - 1);
    // Red varies fastest, per the .cube specification.
    return data[ri + size * (gi + size * bi)]!;
  };
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let dr = 0; dr < 2; dr++)
      for (let dg = 0; dg < 2; dg++)
        for (let db = 0; db < 2; db++) {
          const w =
            (dr ? f[0]! : 1 - f[0]!) * (dg ? f[1]! : 1 - f[1]!) * (db ? f[2]! : 1 - f[2]!);
          acc += w * at(i0[0]! + dr, i0[1]! + dg, i0[2]! + db)[c]!;
        }
    out[c] = acc;
  }
  return out;
}

describe('the ACEScct shaper', () => {
  it('round-trips linear values through the log encoding', () => {
    for (const v of [0, 0.001, 0.0078125, 0.18, 1, 16, 65504]) {
      expect(acesCctToLinear(linearToAcesCct(v))).toBeCloseTo(v, 5);
    }
  });

  it('places 18% grey where the ACEScct specification puts it', () => {
    // (log2(0.18) + 9.72) / 17.52
    expect(linearToAcesCct(0.18)).toBeCloseTo((Math.log2(0.18) + 9.72) / 17.52, 12);
    expect(linearToAcesCct(0.18)).toBeCloseTo(0.4135884, 6);
  });

  it('uses the linear segment below the breakpoint, so zero stays representable', () => {
    expect(linearToAcesCct(0)).toBeCloseTo(0.0729055341958355, 12);
    expect(acesCctToLinear(0.0729055341958355)).toBeCloseTo(0, 9);
  });
});

describe('the .cube file', () => {
  const cube = generateCubeLUT(params, { title: 'test' });
  const { size, data } = parse(cube);

  it('declares a 33-node grid by default', () => {
    expect(DEFAULT_LUT_SIZE).toBe(33);
    expect(size).toBe(33);
    expect(data.length).toBe(33 * 33 * 33);
  });

  it('carries the domain declaration a .cube needs', () => {
    expect(cube).toContain('LUT_3D_SIZE 33');
    expect(cube).toContain('DOMAIN_MIN 0.0 0.0 0.0');
    expect(cube).toContain('DOMAIN_MAX 1.0 1.0 1.0');
    expect(cube).toContain('TITLE "test"');
  });

  it('states its input space, because a LUT applied in the wrong one is silently wrong', () => {
    expect(cube).toMatch(/ACEScct/);
    expect(cube).toMatch(/AP1/);
  });

  it('names the stages it could not bake', () => {
    // The single most important line in the file: someone who bakes a film look
    // and ships it without grain, halation or adjacency should have been told.
    expect(cube).toMatch(/grain/i);
    expect(cube).toMatch(/halation/i);
    expect(cube).toMatch(/interlayer/i);
  });

  it('records the recipe it was baked from, so a look can be traced back', () => {
    expect(cube).toContain('neg.portra400');
    expect(cube).toContain('prt.2383');
  });

  it('emits only finite values inside the unit cube', () => {
    for (const px of data) {
      for (const v of px) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('varies red fastest, then green, then blue, as the format specifies', () => {
    // Asserted against the chain at the coordinates each index should hold,
    // rather than against the output moving: a red input legitimately moves the
    // blue output, because the crosstalk matrix couples the records. Testing
    // "blue stays put" would be testing that the print stage does nothing.
    const step = 1 / (size - 1);
    const cases: [number, [number, number, number]][] = [
      [1, [step, 0, 0]],
      [size, [0, step, 0]],
      [size * size, [0, 0, step]],
    ];
    for (const [index, cct] of cases) {
      const expected = lutOutputFor(cct, params);
      for (let c = 0; c < 3; c++) expect(data[index]![c], `index ${index}`).toBeCloseTo(expected[c]!, 5);
    }
  });
});

describe('the baked LUT against the chain it came from', () => {
  const { size, data } = parse(generateCubeLUT(params));

  it('reproduces the chain exactly at its nodes', () => {
    for (const node of [
      [0, 0, 0],
      [16, 16, 16],
      [32, 32, 32],
      [8, 20, 30],
      [30, 4, 12],
    ] as const) {
      const idx = node[0] + size * (node[1] + size * node[2]);
      const cct = node.map((n) => n / (size - 1)) as unknown as [number, number, number];
      const expected = lutOutputFor(cct, params);
      for (let c = 0; c < 3; c++) expect(data[idx]![c]).toBeCloseTo(expected[c]!, 5);
    }
  });

  it('interpolates between nodes without visible drift', () => {
    // A handful of probe points is not a test of a LUT: the error concentrates
    // in the steep part of the curve, and a sparse sweep walks straight past
    // it. This is the dense sweep `measureCubeError` runs, over the live range.
    // The default grid is 33³; measured worst deviation there is 2.2 code values
    // — 33³ does not meet one, which is exactly why `bakeCube` refines the grid
    // instead of shipping this size. The assertion locks the measurement, so a
    // change to the chain or the grid arithmetic has to move a number it names.
    expect(measureCubeError(params, size) * 255).toBeLessThan(3);
  });

  it('puts a scene neutral where the aim balance puts it', () => {
    const grey = linearToAcesCct(0.18);
    const out = sample(data, size, [grey, grey, grey]);
    // Neutral in, near-neutral out: the print's aim carries a slight warm
    // gradient by design, so this is a closeness test, not an equality one.
    expect(Math.abs(out[0]! - out[1]!)).toBeLessThan(0.03);
    expect(Math.abs(out[1]! - out[2]!)).toBeLessThan(0.03);
  });

  it('is a different table for a different recipe', () => {
    const other = resolve({ ...defaultRecipe(), negativeId: IDEAL_NEGATIVE_ID }, ctx);
    const b = parse(generateCubeLUT(other));

    // The neutral axis is where a stock change has to show: every node on it is
    // a grey, so none of it is lost to gamut clipping at the cube's corners.
    let axisDiffering = 0;
    for (let i = 0; i < size; i++) {
      const idx = i + size * (i + size * i);
      if (Math.abs(data[idx]![0] - b.data[idx]![0]) > 1e-3) axisDiffering++;
    }
    // Only about eleven nodes of the thirty-three carry the transition: the
    // rest of the ACEScct range is below the toe or above the shoulder and
    // clips flat on any stock. That narrowness is exactly why this file
    // measures its own accuracy rather than trusting a grid size.
    expect(axisDiffering).toBeGreaterThan(8);

    // Across the whole cube a large minority differ rather than a majority,
    // because both tables clip to the same black and the same white over much
    // of it — a saturated corner is out of gamut on any stock.
    let differing = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]![0] - b.data[i]![0]) > 1e-4) differing++;
    }
    expect(differing).toBeGreaterThan(data.length / 8);
  });

  it('honours a requested grid size', () => {
    const small = parse(generateCubeLUT(params, { size: 17 }));
    expect(small.size).toBe(17);
    expect(small.data.length).toBe(17 ** 3);
  });

  it('refuses a grid too coarse to carry a film curve', () => {
    expect(() => generateCubeLUT(params, { size: 4 })).toThrow(/size/i);
  });
});

/**
 * The part that makes the export worth trusting.
 *
 * A 3D LUT of a film chain is an approximation, and how good an approximation
 * depends entirely on where the stock's curve is steep relative to where the
 * grid's nodes fall. A colour negative at gamma 0.6 is gentle and a fine enough
 * grid (85³, measured) carries it to one code value; a reversal stock at
 * |gamma| 2 puts its entire toe inside about four nodes and stays coarser than
 * that at every size a .cube can hold. Nothing about the file shows this, so
 * the bake measures it and says so.
 */
describe('measured accuracy', () => {
  it('finds the error a sparse probe set misses', () => {
    // 17³ is a real grid size people ship. On a colour negative it is wrong by
    // several code values, which is visible as banding in a gradient.
    expect(measureCubeError(params, 17) * 255).toBeGreaterThan(4);
    expect(measureCubeError(params, 65) * 255).toBeLessThan(1);
  });

  it('is far worse for a reversal stock than for a negative at the same size', () => {
    const velvia = resolve({ ...defaultRecipe(), negativeId: 'rev.velvia50', printEngine: 'model' }, ctx);
    expect(measureCubeError(velvia, 33)).toBeGreaterThan(measureCubeError(params, 33) * 3);
  });

  it('chooses a grid that meets the tolerance rather than a fixed one', () => {
    const velvia = resolve({ ...defaultRecipe(), negativeId: 'rev.velvia50', printEngine: 'model' }, ctx);
    const gentle = bakeCube(params);
    const steep = bakeCube(velvia);
    expect(steep.size).toBeGreaterThan(gentle.size);
    expect(gentle.worstError * 255).toBeLessThan(1);
  });

  it('stamps the measured error into the file, in code values', () => {
    const baked = bakeCube(params);
    expect(baked.cube).toMatch(/ACCURACY/);
    expect(baked.cube).toMatch(/\/255/);
    expect(baked.cube).toContain(`LUT_3D_SIZE ${baked.size}`);
  });

  it('says so in the file when no available grid meets the tolerance', () => {
    const velvia = resolve({ ...defaultRecipe(), negativeId: 'rev.velvia50', printEngine: 'model' }, ctx);
    const baked = bakeCube(velvia);
    if (baked.worstError * 255 > 1) {
      expect(baked.cube).toMatch(/exceeds|cannot|coarser/i);
    }
    // Either way the number in the header is the measured one, not a claim.
    expect(baked.cube).toContain((baked.worstError * 255).toFixed(2));
  });
});
