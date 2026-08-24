/**
 * Numerically stable primitives shared by the density models.
 *
 * The naive softplus `a * log(1 + exp(u/a))` overflows for large `u/a` and
 * `log(1+x)` loses every significant digit for small `x`, which shows up as a
 * visibly stair-stepped toe in deep shadow (§VI). Every softplus in the
 * pipeline — host side and shader side — uses the stable form below.
 */

/** Minimum softness. The UI clamps its sliders, but core cannot assume that. */
export const MIN_SOFTNESS = 1e-3;

/** log(1 + x) accurate for small x. */
export function log1p(x: number): number {
  return Math.log1p(x);
}

/** exp(x) - 1 accurate for small x. */
export function expm1(x: number): number {
  return Math.expm1(x);
}

/** Softplus with sharpness `a`, evaluated so it cannot overflow. */
export function softplus(u: number, a: number): number {
  const k = Math.max(a, MIN_SOFTNESS);
  return Math.max(u, 0) + k * Math.log1p(Math.exp(-Math.abs(u) / k));
}

/** The derivative of softplus. Branchless overflow avoidance on both tails. */
export function logistic(t: number): number {
  if (t >= 0) return 1 / (1 + Math.exp(-t));
  const e = Math.exp(t);
  return e / (1 + e);
}

export function clampSoftness(k: number): number {
  return Math.max(k, MIN_SOFTNESS);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** log10 of a value floored away from zero. §V: AP1 makes negatives rare, not impossible. */
export const EXPOSURE_FLOOR = 1e-7;

export function safeLog10(e: number): number {
  return Math.log10(Math.max(e, EXPOSURE_FLOOR));
}
