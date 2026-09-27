/**
 * IEEE 754 binary16 encoding, round-to-nearest-even — how the measured print
 * tables reach the GPU as RGBA16F. Truncating instead would bias every node
 * downward by up to one half-float ulp; small, but a systematic bias in a
 * measurement is exactly what the table exists not to have.
 */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function floatToHalf(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const man = x & 0x7fffff;
  if (exp === 0xff) return sign | (man ? 0x7e00 : 0x7c00); // NaN / infinity
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    // Subnormal half: value = h * 2^-24.
    if (e < -10) return sign;
    const m = man | 0x800000;
    const shift = 14 - e;
    let h = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (h & 1) === 1)) h++;
    return sign | h;
  }
  let h = (e << 10) | (man >>> 13);
  const rem = man & 0x1fff;
  // A carry out of the mantissa rolls into the exponent, which is correct —
  // including the roll to infinity at the top of the range.
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1) === 1)) h++;
  return sign | h;
}

/** The exact inverse, for tests. */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return sign * m * Math.pow(2, -24);
  if (e === 0x1f) return m ? NaN : sign * Infinity;
  return sign * (1 + m / 1024) * Math.pow(2, e - 15);
}
