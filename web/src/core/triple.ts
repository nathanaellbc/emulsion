/**
 * Per-record values and the 3x3 operators that act on them.
 *
 * Kept as plain arrays rather than classes: every one of these ends up in a
 * `Float32Array` uniform, and the shape `[r, g, b]` is what WebGL wants.
 */

export type Triple = readonly [number, number, number];
/** Row-major 3x3. `m[row][col]`, so `m[0][1]` is the green contribution to red. */
export type Matrix3 = readonly [Triple, Triple, Triple];

export const RECORDS = [0, 1, 2] as const;
export type Record3 = 0 | 1 | 2;

export function tri(r: number, g: number, b: number): Triple {
  return [r, g, b];
}

export function triFill(v: number): Triple {
  return [v, v, v];
}

export function triAdd(a: Triple, b: Triple): Triple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function triSub(a: Triple, b: Triple): Triple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function triMul(a: Triple, b: Triple): Triple {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function triScale(a: Triple, s: number): Triple {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function triMap(a: Triple, f: (v: number, i: Record3) => number): Triple {
  return [f(a[0], 0), f(a[1], 1), f(a[2], 2)];
}

export function triSum(a: Triple): number {
  return a[0] + a[1] + a[2];
}

export function triIsFinite(a: Triple): boolean {
  return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}

export const IDENTITY3: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export function matMulVec(m: Matrix3, v: Triple): Triple {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function matMul(a: Matrix3, b: Matrix3): Matrix3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i]![k]! * b[k]![j]!;
      out[i]![j] = s;
    }
  }
  return out as unknown as Matrix3;
}

export function matInverse(m: Matrix3): Matrix3 {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return IDENTITY3;
  const inv = 1 / det;
  return [
    [(e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv],
    [(f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv],
    [(d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv],
  ];
}

export function matTranspose(m: Matrix3): Matrix3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

/** Column-major Float32Array, the layout `uniformMatrix3fv` expects. */
export function matToGL(m: Matrix3): Float32Array {
  return new Float32Array([
    m[0][0], m[1][0], m[2][0],
    m[0][1], m[1][1], m[2][1],
    m[0][2], m[1][2], m[2][2],
  ]);
}

export function triToGL(t: Triple): Float32Array {
  return new Float32Array([t[0], t[1], t[2]]);
}

/**
 * Scales the off-diagonal terms only. Used by the saturation-density control
 * (§X) and by per-print-stock crosstalk variation (Appendix A).
 */
export function scaleOffDiagonal(m: Matrix3, s: number): Matrix3 {
  return [
    [m[0][0], m[0][1] * s, m[0][2] * s],
    [m[1][0] * s, m[1][1], m[1][2] * s],
    [m[2][0] * s, m[2][1] * s, m[2][2]],
  ];
}
