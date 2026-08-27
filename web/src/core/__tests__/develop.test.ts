/**
 * The camera develop (DEVIATIONS.md finding 14).
 *
 * The paper publishes nothing for this stage, so there are no published values
 * to test against — what the suite can and does hold are the *properties the
 * stage claims about itself*: identity at the defaults, monotonicity in
 * luminance, exact chromaticity preservation under every tone control, exact
 * luminance preservation under saturation, mask locality, and the bake/render
 * parity that makes the exported LUT match the screen.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA_DEVELOP,
  LUMA_FLOOR,
  MASK_BLACK,
  MASK_HIGHLIGHT,
  SCENE_GREY,
  develop,
  developIsIdentity,
  developLuma,
  type CameraDevelopParams,
} from '../develop';
import { resolve } from '../resolve';
import { defaultRecipe } from '../recipe';
import { lutOutputFor } from '../lut';
import { evaluateLogExposure, sceneLogExposure } from '../chain';
import type { Triple } from '../triple';

const IDENTITY = DEFAULT_CAMERA_DEVELOP;

/** A develop with one knob turned. */
function with_(patch: Partial<CameraDevelopParams>): CameraDevelopParams {
  return { ...IDENTITY, ...patch };
}

/** Stops over scene grey, the domain the tone controls work in. */
const stops = (y: number) => Math.log2(y / SCENE_GREY);

describe('the camera develop', () => {
  it('is the identity at the defaults, to 1e-9', () => {
    expect(developIsIdentity(IDENTITY)).toBe(true);
    for (const y of [1e-6, 0.001, 0.18, 1, 4, 100, 4000]) {
      expect(developLuma(y, IDENTITY)).toBeCloseTo(y, 9);
    }
    const rgb: Triple = [0.31, 0.57, 0.12];
    expect(develop(rgb, IDENTITY)).toEqual([
      expect.closeTo(rgb[0], 9),
      expect.closeTo(rgb[1], 9),
      expect.closeTo(rgb[2], 9),
    ]);
  });

  it('every tone control is monotone in luminance, alone at its extreme', () => {
    const extremes: CameraDevelopParams[] = [
      with_({ contrast: Math.pow(2, 0.75) }),
      with_({ contrast: Math.pow(2, -0.75) }),
      with_({ highlights: 1.5 }),
      with_({ highlights: -1.5 }),
      with_({ shadows: 1.5 }),
      with_({ shadows: -1.5 }),
      with_({ whites: 2 }),
      with_({ whites: -2 }),
      with_({ blacks: 2 }),
      with_({ blacks: -2 }),
    ];
    const grid: number[] = [];
    for (let s = -10; s <= 12; s += 0.125) grid.push(SCENE_GREY * Math.pow(2, s));
    for (const p of extremes) {
      let prev = -Infinity;
      for (const y of grid) {
        const out = developLuma(y, p);
        expect(out).toBeGreaterThanOrEqual(prev);
        prev = out;
        expect(Number.isFinite(out)).toBe(true);
        expect(out).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('any pair of controls at their extremes is still monotone', () => {
    // The envelope the interface ships: pairwise-extreme settings stay
    // monotone. Three or more simultaneous extremes can invert the tone curve,
    // as any parametric curve editor can — recorded in DEVIATIONS.md rather
    // than clamped away.
    const knobs: (keyof CameraDevelopParams)[] = [
      'contrast',
      'highlights',
      'shadows',
      'whites',
      'blacks',
    ];
    // Each knob's two extremes: contrast steepens or flattens (the inverse
    // multiplier), the stop-valued controls go positive or negative.
    const extremes = (k: keyof CameraDevelopParams): number[] => {
      if (k === 'contrast') return [Math.pow(2, 0.75), Math.pow(2, -0.75)];
      if (k === 'whites' || k === 'blacks') return [2, -2];
      return [1.5, -1.5];
    };
    const grid: number[] = [];
    for (let s = -10; s <= 12; s += 0.125) grid.push(SCENE_GREY * Math.pow(2, s));
    for (let i = 0; i < knobs.length; i++) {
      for (let j = i + 1; j < knobs.length; j++) {
        for (const vi of extremes(knobs[i]!)) {
          for (const vj of extremes(knobs[j]!)) {
            const p = with_({ [knobs[i]!]: vi, [knobs[j]!]: vj } as Partial<CameraDevelopParams>);
            let prev = -Infinity;
            for (const y of grid) {
              const out = developLuma(y, p);
              expect(out).toBeGreaterThanOrEqual(prev);
              prev = out;
            }
          }
        }
      }
    }
  });

  it('tone controls preserve chromaticity exactly', () => {
    // A per-pixel luminance mapping is a scalar gain; the ratios between
    // records must survive every tone control untouched.
    const rgb: Triple = [0.42, 0.11, 0.23];
    const p = with_({
      contrast: 1.6,
      highlights: -1.5,
      shadows: 1.5,
      whites: 1,
      blacks: -1,
      saturation: 1,
    });
    const out = develop(rgb, p);
    expect(out[0] / out[1]).toBeCloseTo(rgb[0] / rgb[1], 9);
    expect(out[0] / out[2]).toBeCloseTo(rgb[0] / rgb[2], 9);
    expect(out[1] / out[2]).toBeCloseTo(rgb[1] / rgb[2], 9);
  });

  it('saturation preserves luminance exactly', () => {
    const rgb: Triple = [0.42, 0.11, 0.23];
    const y = 0.2722 * rgb[0] + 0.6741 * rgb[1] + 0.0537 * rgb[2];
    for (const s of [0, 0.35, 1, 1.6, 2]) {
      const out = develop(rgb, with_({ saturation: s }));
      const yOut = 0.2722 * out[0] + 0.6741 * out[1] + 0.0537 * out[2];
      expect(yOut).toBeCloseTo(y, 9);
    }
  });

  it('saturation at 0 is luminance; at 2 the records spread about it', () => {
    const rgb: Triple = [0.42, 0.11, 0.23];
    const mono = develop(rgb, with_({ saturation: 0 }));
    expect(mono[0]).toBeCloseTo(mono[1], 9);
    expect(mono[1]).toBeCloseTo(mono[2], 9);
    // The spread doubles at s = 2 relative to s = 1.
    const one = develop(rgb, IDENTITY);
    const two = develop(rgb, with_({ saturation: 2 }));
    expect(two[0] - two[1]).toBeCloseTo(2 * (one[0] - one[1]), 9);
  });

  it('neutrals stay neutral under every control', () => {
    for (const y of [0.01, 0.18, 1.6]) {
      const grey: Triple = [y, y, y];
      const p = with_({ contrast: 1.5, highlights: -1, shadows: 1, whites: 1, blacks: -1, saturation: 0.3 });
      const out = develop(grey, p);
      expect(out[0]).toBeCloseTo(out[1], 12);
      expect(out[1]).toBeCloseTo(out[2], 12);
    }
  });

  it('masks act where they claim to and barely touch where they do not', () => {
    // Full highlights recovery must move a +4 EV pixel far more than a −4 EV
    // one, and the mirror for shadows.
    const hi = SCENE_GREY * Math.pow(2, MASK_HIGHLIGHT.centre);
    const lo = SCENE_GREY * Math.pow(2, MASK_BLACK.centre);
    const dropHi = developLuma(hi, with_({ highlights: -1.5 })) / hi;
    const dropLo = developLuma(lo, with_({ highlights: -1.5 })) / lo;
    expect(dropHi).toBeLessThan(dropLo);
    expect(dropHi).toBeLessThan(1); // actually recovers the highlight
    expect(dropLo).toBeGreaterThan(0.85); // barely touches the black end

    const liftLo = developLuma(lo, with_({ shadows: 1.5 })) / lo;
    const liftHi = developLuma(hi, with_({ shadows: 1.5 })) / hi;
    expect(liftLo).toBeGreaterThan(liftHi);
    expect(liftLo).toBeGreaterThan(1);
    expect(liftHi).toBeLessThan(1.15);
  });

  it('black never goes negative, and an additive black floor stays small', () => {
    // Blacks act additively in log space, so a lift raises true black by a
    // small finite amount (0.18·2^(stops) at the floor) rather than leaving it
    // exactly zero — that is the property "additive" buys. What must hold is
    // finiteness, non-negativity, and a floor orders below anything visible.
    const lifted = developLuma(0, with_({ blacks: 2, shadows: 1.5 }));
    expect(lifted).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(lifted)).toBe(true);
    expect(lifted).toBeLessThan(1e-4);

    const crushed = developLuma(0, with_({ blacks: -2, shadows: -1.5 }));
    // Negative stops push the floor down, but log2 of the floor bounds how
    // far: the result is positive, finite and far below anything visible.
    expect(crushed).toBeLessThan(LUMA_FLOOR * 10);
    expect(Number.isFinite(crushed)).toBe(true);

    const out = develop([0, 0, 0], with_({ whites: 2, highlights: 1.5, saturation: 2 }));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    // Every output everywhere is finite and non-negative.
    const p = with_({ whites: 2, highlights: 1.5, shadows: 1.5, blacks: 2, saturation: 2 });
    for (const y of [0, 1e-9, 0.18, 50, 1e6]) {
      const v = developLuma(y, p);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('contrast pivots about scene grey', () => {
    const p = with_({ contrast: 1.68 });
    expect(developLuma(SCENE_GREY, p)).toBeCloseTo(SCENE_GREY, 12);
    const above = stops(developLuma(SCENE_GREY * 2, p));
    const below = stops(developLuma(SCENE_GREY / 2, p));
    expect(above).toBeCloseTo(1.68, 2);
    expect(below).toBeCloseTo(-1.68, 2);
  });

  it('resolve produces the dense develop from the recipe settings', () => {
    const recipe = defaultRecipe();
    let resolved = resolve(recipe, { renderWidthPx: 2048, sourceSpace: 'srgb' });
    expect(developIsIdentity(resolved.camera)).toBe(true);

    recipe.camera.contrast = 0.5;
    recipe.camera.highlights = -0.75;
    recipe.camera.saturation = 1.25;
    resolved = resolve(recipe, { renderWidthPx: 2048, sourceSpace: 'srgb' });
    expect(resolved.camera.contrast).toBeCloseTo(Math.sqrt(2), 9);
    expect(resolved.camera.highlights).toBe(-0.75);
    expect(resolved.camera.saturation).toBe(1.25);
  });
});

describe('develop parity: the bake and the render', () => {
  it('the LUT bake carries the develop, identically to the chain', () => {
    // A non-trivial develop on a colour mid-grey, evaluated through the bake
    // path (lutOutputFor) and the render path (sceneLogExposure +
    // evaluateLogExposure), must agree: the develop is applied once, upstream
    // of the log, in both. Both paths share `develop` — what this actually
    // holds is that the bake's preamble and the chain's preamble place it
    // identically, so an exported LUT still matches the screen.
    const recipe = defaultRecipe();
    recipe.camera.contrast = 0.4;
    recipe.camera.highlights = -0.6;
    recipe.camera.shadows = 0.5;
    recipe.camera.whites = -0.25;
    recipe.camera.blacks = 0.3;
    recipe.camera.saturation = 1.2;
    const p = resolve(recipe, { renderWidthPx: 2048, sourceSpace: 'srgb' });

    for (const y of [0.01, 0.18, 0.6, 2.5]) {
      const sceneLinear: Triple = [y, y, y];

      // Render path: exactly what the host chain runs.
      const chainLogE = sceneLogExposure(sceneLinear, p);
      const chainOut = evaluateLogExposure(chainLogE, p);

      // Bake path: scene-linear -> ACEScct (the bake's domain), then through
      // lutOutputFor, which applies WB, gain, develop, log and the engine.
      const cct: Triple = [
        (Math.log2(Math.max(y, 1e-7)) + 9.72) / 17.52,
        (Math.log2(Math.max(y, 1e-7)) + 9.72) / 17.52,
        (Math.log2(Math.max(y, 1e-7)) + 9.72) / 17.52,
      ];
      const bakeOut = lutOutputFor(cct, p);

      // The bake emits display-encoded; undo it and compare in linear.
      for (let c = 0 as 0 | 1 | 2; c < 3; c++) {
        const decoded = bakeOut[c]! <= 0.0031308
          ? bakeOut[c]! * 12.92
          : Math.pow((bakeOut[c]! + 0.055) / 1.055, 2.4);
        const msg = `at y=${y}, channel ${c}`;
        expect(chainOut[c], msg).toBeCloseTo(decoded, 4);
      }
    }
  });

  it('the develop sits before the log, so it changes what the film sees', () => {
    // A develop that lifts shadows must move a dark pixel's film exposure,
    // which is the entire point of the stage's placement.
    const recipe = defaultRecipe();
    const p0 = resolve(recipe, { renderWidthPx: 2048, sourceSpace: 'srgb' });
    recipe.camera.shadows = 1.5;
    const p1 = resolve(recipe, { renderWidthPx: 2048, sourceSpace: 'srgb' });

    const dark: Triple = [0.01, 0.01, 0.01];
    const e0 = develop(dark, p1.camera)[1];
    expect(e0).toBeGreaterThan(dark[1] * 1.05);

    // And the anchor itself is untouched: the develop grades the light, it
    // does not re-rate the film.
    expect(p1.anchorShift).toBe(p0.anchorShift);
  });
});
