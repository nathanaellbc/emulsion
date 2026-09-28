import { describe, expect, it } from 'vitest';
import { signedCocPx } from '../defocus';
import { clampRecipe, defaultRecipe, mergeRecipe, type Recipe } from '../recipe';
import { resolve } from '../resolve';

/** The lens's foreground controls: the near sharp limit and the foreground amount. */

const ctx = { renderWidthPx: 2048, renderHeightPx: 1365, sourceSpace: 'srgb' as const, focusDisparity: 0.5 };

const withDefocus = (patch: Partial<Recipe['defocus']>) => {
  const r = defaultRecipe();
  return clampRecipe({ ...r, defocus: { ...r.defocus, enabled: true, ...patch } });
};

const cocOf = (p: ReturnType<typeof resolve>['defocus']) => (d: number) =>
  signedCocPx(d, p.focusDisparity, p.cocScalePx, 1e9, p.nearDisparity, p.foreground);

describe('the foreground controls', () => {
  it('are the thin lens exactly at rest', () => {
    const p = resolve(withDefocus({}), ctx).defocus;
    expect(p.nearDisparity).toBe(p.focusDisparity);
    expect(p.foreground).toBe(1);
    for (const d of [0.1, 0.5, 0.7, 1]) {
      expect(cocOf(p)(d)).toBe(signedCocPx(d, p.focusDisparity, p.cocScalePx, 1e9));
    }
  });

  it('hold the zone between the near limit and the focal plane sharp, then blur at the lens rate', () => {
    // Focus 2.5 m, sharp from 1.25 m: the near limit sits at twice the focus disparity.
    const p = resolve(withDefocus({ focusDistanceM: 2.5, nearSharpM: 1.25 }), ctx).defocus;
    expect(p.nearDisparity).toBeCloseTo(1.0, 9);
    const coc = cocOf(p);
    expect(coc(0.6)).toBeCloseTo(0, 12);
    expect(coc(0.99)).toBeCloseTo(0, 12);
    // In front of the limit the disc grows exactly as the lens's does from the focal plane.
    expect(coc(1.2)).toBeCloseTo(signedCocPx(0.7, 0.5, p.cocScalePx, 1e9), 9);
    // Behind the focal plane nothing changed.
    expect(coc(0.2)).toBeCloseTo(signedCocPx(0.2, 0.5, p.cocScalePx, 1e9), 9);
    expect(p.nearLimitM).toBeLessThan(1.25);
  });

  it('cut the foreground sharp at 0, and leave the background alone', () => {
    const p = resolve(withDefocus({ foreground: 0 }), ctx).defocus;
    expect(cocOf(p)(0.9)).toBeCloseTo(0, 12);
    expect(cocOf(p)(0.1)).toBeGreaterThan(0);
    expect(p.nearLimitM).toBe(0);
  });

  it('scale the foreground disc linearly between cut and lens', () => {
    const half = resolve(withDefocus({ foreground: 0.5 }), ctx).defocus;
    expect(cocOf(half)(0.8)).toBeCloseTo(0.5 * signedCocPx(0.8, 0.5, half.cocScalePx, 1e9), 9);
    const full = resolve(withDefocus({}), ctx).defocus;
    expect(half.nearLimitM).toBeLessThan(full.nearLimitM);
  });

  it('drop a near limit that is not in front of the focus, and default a stored recipe', () => {
    expect(withDefocus({ focusDistanceM: 2, nearSharpM: 3 }).defocus.nearSharpM).toBeNull();
    const old = clampRecipe(
      mergeRecipe(defaultRecipe(), { defocus: { enabled: true } } as unknown as Partial<Recipe>),
    );
    expect(old.defocus.nearSharpM).toBeNull();
    expect(old.defocus.foreground).toBe(1);
  });
});
