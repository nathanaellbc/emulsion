import { describe, expect, it } from 'vitest';
import {
  F_STOPS,
  NORMAL_FOCAL_MM,
  acceptableCocMm,
  cocAtInfinityMm,
  cocMm,
  depthOfField,
  nearestStop,
  signedCocPx,
} from '../defocus';
import { clampRecipe, defaultRecipe, mergeRecipe, type Recipe } from '../recipe';
import { resolve } from '../resolve';

describe('thin-lens circle of confusion', () => {
  it('reproduces the textbook depth of field: 50 mm, f/8, 3 m, c = 0.030 mm', () => {
    const dof = depthOfField(50, 8, 3000, 0.03);
    expect(dof.hyperfocalMm).toBeCloseTo(10466.7, 0);
    expect(dof.nearMm).toBeCloseTo(2338, 0);
    expect(dof.farMm).toBeCloseTo(4185, 0);
  });

  it('is exactly the permissible CoC at both limits of the depth of field', () => {
    for (const [f, n, z] of [
      [50, 2, 2500],
      [85, 1.4, 1800],
      [24, 8, 5000],
      [150, 5.6, 4000],
    ] as const) {
      const c = 0.03;
      const dof = depthOfField(f, n, z, c);
      expect(cocMm(f, n, z, dof.nearMm)).toBeCloseTo(c, 9);
      if (Number.isFinite(dof.farMm)) expect(cocMm(f, n, z, dof.farMm)).toBeCloseTo(c, 9);
    }
  });

  it('reaches a finite disc at infinity, and the far limit becomes infinite past the hyperfocal', () => {
    expect(cocMm(50, 2, 3000, 1e15)).toBeCloseTo(cocAtInfinityMm(50, 2, 3000), 9);
    const dof = depthOfField(28, 11, 5000, 0.03);
    expect(dof.hyperfocalMm).toBeLessThan(5000);
    expect(dof.farMm).toBe(Infinity);
  });

  it('turns a relative disparity metric through the focus distance, as the paper’s CoC', () => {
    // A metric scene: the map's disparity is d = d_f · z_f / z, i.e. 1/z up to
    // the scale the focus point fixes, with infinity at d = 0.
    const f = 85;
    const N = 1.8;
    const zf = 2000;
    const df = 0.6;
    const pitchUm = 36000 / 2048;
    const scalePx = (cocAtInfinityMm(f, N, zf) * 1000) / pitchUm;
    for (const z of [900, 1500, 2000, 3500, 10000, 1e9]) {
      const d = (df * zf) / z;
      const px = signedCocPx(d, df, scalePx, 1e9);
      expect(Math.abs(px) * pitchUm / 1000).toBeCloseTo(cocMm(f, N, zf, z), 9);
      // Behind the focal plane positive, in front of it negative.
      expect(Math.sign(px)).toBe(z > zf ? 1 : z < zf ? -1 : 0);
    }
  });

  it('clamps at the gather’s reach', () => {
    expect(signedCocPx(0, 0.5, 400, 200)).toBe(200);
    expect(signedCocPx(10, 0.5, 400, 200)).toBe(-200);
  });

  it('gives 35 mm its familiar 0.030 mm', () => {
    expect(acceptableCocMm('format135', 1.5)).toBeCloseTo(0.03, 3);
    // Orientation does not matter: a portrait frame is the same frame.
    expect(acceptableCocMm('format135', 2 / 3)).toBeCloseTo(acceptableCocMm('format135', 1.5), 12);
  });

  it('snaps to marked third stops', () => {
    expect(nearestStop(1.95)).toBe(2);
    expect(nearestStop(5.4)).toBe(5.6);
    expect(F_STOPS[0]).toBe(1.2);
    expect(F_STOPS[F_STOPS.length - 1]).toBe(22);
  });
});

describe('the defocus stage in the recipe and the resolve', () => {
  const withDefocus = (patch: Partial<Recipe['defocus']>, format: Recipe['format'] = 'format135') => {
    const r = defaultRecipe();
    return clampRecipe({ ...r, format, defocus: { ...r.defocus, enabled: true, ...patch } });
  };

  it('fills in a recipe saved before the stage existed', () => {
    const stored = JSON.parse(JSON.stringify(defaultRecipe())) as Partial<Recipe>;
    delete (stored as { defocus?: unknown }).defocus;
    const r = clampRecipe(mergeRecipe(defaultRecipe(), stored));
    expect(r.defocus.enabled).toBe(false);
    expect(r.defocus.fNumber).toBe(2);
  });

  it('allows a round iris or five to nine blades, nothing between', () => {
    expect(withDefocus({ blades: 3 }).defocus.blades).toBe(0);
    expect(withDefocus({ blades: 7 }).defocus.blades).toBe(7);
    expect(withDefocus({ blades: 14 }).defocus.blades).toBe(9);
  });

  it('stays off without a depth map, whatever the recipe says', () => {
    const r = withDefocus({});
    expect(resolve(r, { renderWidthPx: 2048, renderHeightPx: 1365, sourceSpace: 'srgb' }).defocus.enabled).toBe(false);
    expect(
      resolve(r, { renderWidthPx: 2048, renderHeightPx: 1365, sourceSpace: 'srgb', focusDisparity: 0.5 }).defocus
        .enabled,
    ).toBe(true);
  });

  it('uses the format’s normal lens until one is chosen', () => {
    const ctx = { renderWidthPx: 2048, renderHeightPx: 1365, sourceSpace: 'srgb' as const, focusDisparity: 0.5 };
    expect(resolve(withDefocus({}, 'format645'), ctx).defocus.focalLengthMm).toBe(NORMAL_FOCAL_MM.format645);
    expect(resolve(withDefocus({ focalLengthMm: 135 }), ctx).defocus.focalLengthMm).toBe(135);
  });

  it('is shallower on a larger frame at the same f-number and field of view', () => {
    const ctx = { renderWidthPx: 2048, renderHeightPx: 1365, sourceSpace: 'srgb' as const, focusDisparity: 0.5 };
    const big = resolve(withDefocus({ fNumber: 2 }, 'format645'), ctx).defocus;
    const small = resolve(withDefocus({ fNumber: 2 }, 'super16'), ctx).defocus;
    expect(big.cocScalePx).toBeGreaterThan(4 * small.cocScalePx);
    expect(big.farLimitM - big.nearLimitM).toBeLessThan(small.farLimitM - small.nearLimitM);
  });

  it('is a physical size: the same picture blurs the same fraction of the frame at any render size', () => {
    const r = withDefocus({ fNumber: 1.4, focalLengthMm: 85 });
    const a = resolve(r, { renderWidthPx: 2048, renderHeightPx: 1365, sourceSpace: 'srgb', focusDisparity: 0.5 });
    const b = resolve(r, { renderWidthPx: 6000, renderHeightPx: 4000, sourceSpace: 'srgb', focusDisparity: 0.5 });
    expect(a.defocus.cocScalePx / 2048).toBeCloseTo(b.defocus.cocScalePx / 6000, 9);
    expect(a.defocus.maxCocPx / 2048).toBeCloseTo(b.defocus.maxCocPx / 6000, 9);
  });
});
