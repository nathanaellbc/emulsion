/**
 * GLSL fragments shared by every pass. The softplus here must match
 * `core/math.ts` exactly — the whole point of a single evaluation path is that
 * the host's sensitometry readout and the GPU's pixels agree.
 */

export const GLSL_COMMON = /* glsl */ `
precision highp float;
precision highp sampler2D;

const float LOG10 = 2.302585092994046;
const float INV_LOG10 = 0.4342944819032518;
const float EXPOSURE_FLOOR = 1e-7;

/// log(1+x) without the catastrophic cancellation of the naive form. Highp
/// float has 24 bits; the deep toe lives entirely inside the region where
/// log(1.0 + tiny) has already lost every one of them.
float log1p_(float x) {
  return abs(x) < 1e-4 ? x * (1.0 - 0.5 * x + x * x * 0.3333333) : log(1.0 + x);
}

/// Softplus in the stable form: max(u,0) + a*log1p(exp(-|u|/a)).
/// The naive a*log(1+exp(u/a)) overflows around u/a = 88 and stair-steps the toe.
float sp(float u, float a) {
  a = max(a, 1e-3);
  return max(u, 0.0) + a * log1p_(exp(-abs(u) / a));
}

vec3 sp3(vec3 u, vec3 a) {
  return vec3(sp(u.r, a.r), sp(u.g, a.g), sp(u.b, a.b));
}

/// The softplus derivative, and the toe/shoulder weights of the point gamma.
float logistic_(float t) {
  return t >= 0.0 ? 1.0 / (1.0 + exp(-t)) : exp(t) / (1.0 + exp(t));
}
vec3 logistic3(vec3 t) {
  return vec3(logistic_(t.r), logistic_(t.g), logistic_(t.b));
}

float log10_(float x) { return log(max(x, EXPOSURE_FLOOR)) * INV_LOG10; }
vec3 log10_3(vec3 x) {
  return vec3(log10_(x.r), log10_(x.g), log10_(x.b));
}

vec3 exp10_3(vec3 x) { return exp(x * LOG10); }

/// sRGB / Display P3 transfer functions. Shared by both ends of the display path.
float eotf(float v) {
  return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}
vec3 eotf3(vec3 v) { return vec3(eotf(v.r), eotf(v.g), eotf(v.b)); }

float oetf(float v) {
  v = max(v, 0.0);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}
vec3 oetf3(vec3 v) { return vec3(oetf(v.r), oetf(v.g), oetf(v.b)); }
`;

/**
 * The negative's own stages — stages 1 to 3 of §XV-E, plus the development
 * activity that weights the interlayer operator.
 *
 * Shared source rather than two copies, because the interlayer pass has to
 * recompute the log exposure to know how much inhibitor a pixel released, and a
 * second transcription of the characteristic curve is precisely the drift
 * DEVIATIONS.md §9 warns about. Recomputing costs one exp per record; carrying
 * it forward would cost a full-resolution RGBA16F target, which at export size
 * is ninety megabytes.
 */
export const GLSL_NEGATIVE = /* glsl */ `
uniform float uAnchorShift;
uniform vec3  uBalanceShift;
uniform bool  uMono;
uniform vec3  uPan;
uniform vec3  uDMin, uDeltaD, uGamma, uX0, uKappaT, uKappaS, uMask;

/// Stage 1 — the layer balance, and the panchromatic collapse before it for a
/// monochrome stock, which carries one record rather than three.
vec3 filmLogExposure(vec3 e) {
  vec3 s = uMono ? vec3(dot(uPan, e)) : max(e, EXPOSURE_FLOOR);
  return log10_3(s) + uAnchorShift + uBalanceShift;
}

vec3 densityAt(vec3 x, vec3 dMin) {
  vec3 u = uGamma * (x - uX0);
  return dMin + sp3(u, uKappaT) - sp3(u - uDeltaD, uKappaS);
}

/// Stages 2-3. One fixed-point pass: the paper states a second is below AC-1
/// tolerance, so iterating further would buy nothing measurable.
vec3 negativeDensity(vec3 x) {
  vec3 first = densityAt(x, uDMin);
  vec3 corrected = uDMin - uMask * ((first - uDMin) / uDeltaD);
  return densityAt(x, corrected);
}

/// Normalised point gamma. Gamma cancels out of the ratio, leaving
/// toe - shoulder in [0, 1] for a reversal stock exactly as for a negative one,
/// which is why eq. activityweight needs no sign branch.
vec3 developmentActivity(vec3 x) {
  vec3 u = uGamma * (x - uX0);
  vec3 toe = logistic3(u / max(uKappaT, vec3(1e-3)));
  vec3 shoulder = logistic3((u - uDeltaD) / max(uKappaS, vec3(1e-3)));
  return max(toe - shoulder, 0.0);
}
`;

/** PCG-style integer hash: deterministic, well distributed, cheap (§XI). */
export const GLSL_HASH = /* glsl */ `
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float hashToUnit(uint h) {
  return float(h & 0x00ffffffu) / 16777216.0;
}

/// Box-Muller from two hashed uniforms. The epsilon floor keeps log() finite
/// when the hash lands on exactly zero.
vec2 gauss2(uint seed) {
  float u1 = max(hashToUnit(pcg(seed)), 1e-7);
  float u2 = hashToUnit(pcg(seed ^ 0x9e3779b9u));
  float r = sqrt(-2.0 * log(u1));
  float t = 6.283185307179586 * u2;
  return vec2(r * cos(t), r * sin(t));
}
`;
