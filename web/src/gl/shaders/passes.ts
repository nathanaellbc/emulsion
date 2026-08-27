import { GLSL_COMMON, GLSL_HASH, GLSL_NEGATIVE } from './common';

/**
 * Pass 1 — source encoding to the scene-referred working space.
 *
 * Everything before the log lives here: the source-primaries matrix, the von
 * Kries white balance (both collapsed into one 3x3 on the host), the exposure
 * gain, and the camera develop. This is deliberately *outside* the part of
 * the chain that could be baked into a LUT, because the LUT domain is log
 * exposure — baking anything before the log would let a white-balance change
 * silently invalidate it.
 *
 * The develop below is a transcription of `core/develop.ts`, stage for stage
 * and constant for constant. Divergence between the two is a defect in one of
 * them, never a tolerance — the same contract `GLSL_NEGATIVE` carries.
 */
export const FRAG_PREPARE = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform mat3 uInputMatrix;
uniform float uExposureGain;
uniform bool uSourceIsEncoded;
uniform bool uFlipY;

// --- the camera develop (core/develop.ts; DEVIATIONS.md finding 14) ---
uniform bool  uDevelopOn;
uniform float uContrast;     // log-slope multiplier, 1 untouched
uniform float uHighlights;   // stops at the highlight mask centre
uniform float uShadows;      // stops at the shadow mask centre
uniform float uWhites;       // stops at the white end
uniform float uBlacks;       // stops at the black end
uniform float uSaturation;   // factor about luminance, 1 untouched

const float SCENE_GREY = 0.18;
const float LUMA_FLOOR = 1e-7;
const vec3  DEVELOP_Y = vec3(0.2722, 0.6741, 0.0537);

/// The tone masks: logistic, the softplus derivative that builds every other
/// knee in the house, so a mask "begins" as softly as a film curve does. The
/// shadow-side controls pass a mirrored argument — maximal at the low end.
float developMask(float t, float centre, float width) {
  return logistic_((t - centre) / width);
}

/// One luminance through the tone controls — core/develop.ts, developLuma.
float developLuma(float y) {
  float l = log2(max(y, LUMA_FLOOR) / SCENE_GREY);
  float t = l * uContrast;
  t += uHighlights * developMask(t,  1.5, 1.0);
  t += uShadows    * developMask(-t,  1.5, 1.0);  // mirrored: σ((c−t)/w)
  t += uWhites     * developMask(t,  4.0, 2.0);
  t += uBlacks     * developMask(-t,  4.0, 2.0);  // mirrored: σ((c−t)/w)
  return SCENE_GREY * exp2(t);
}

/// The full develop on RGB — core/develop.ts, develop().
vec3 sceneDevelop(vec3 c) {
  float y = dot(DEVELOP_Y, c);
  float gain = y > LUMA_FLOOR ? developLuma(y) / y : developLuma(y) / LUMA_FLOOR;
  vec3 g = c * gain;
  if (uSaturation == 1.0) return g;
  float yOut = y * gain;
  return max(vec3(yOut) + uSaturation * (g - vec3(yOut)), 0.0);
}

void main() {
  vec2 uv = uFlipY ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  vec3 c = texture(uSource, uv).rgb;
  if (uSourceIsEncoded) c = eotf3(c);
  vec3 scene = uInputMatrix * c * uExposureGain;
  if (uDevelopOn) scene = sceneDevelop(scene);
  fragColor = vec4(max(scene, 0.0), 1.0);
}
`;

/**
 * Pass 2a — the halation source term (eq. halsource).
 *
 * Driven by luminance in the linear scene domain, before the characteristic
 * curve. A hard threshold has a discontinuous derivative and leaves a visible
 * contour where the halo begins, so this reuses the softplus knee.
 */
export const FRAG_HAL_SOURCE = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform vec3 uLuminance;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 e = texture(uScene, vUv).rgb;
  float ey = dot(uLuminance, e);
  float s = sp(ey - uThreshold, uKnee);
  fragColor = vec4(s, s, s, 1.0);
}
`;

/** Pass 2b — 2x box downsample. One bilinear tap per 2x2 quad. */
export const FRAG_DOWNSAMPLE = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uSourceTexel;

void main() {
  vec2 o = uSourceTexel * 0.5;
  vec3 s = texture(uSource, vUv + vec2(-o.x, -o.y)).rgb
         + texture(uSource, vUv + vec2( o.x, -o.y)).rgb
         + texture(uSource, vUv + vec2(-o.x,  o.y)).rgb
         + texture(uSource, vUv + vec2( o.x,  o.y)).rgb;
  fragColor = vec4(s * 0.25, 1.0);
}
`;

/**
 * Separable Gaussian. `uDirection` is the texel step, so the same program runs
 * both axes. Nine taps with linear-sampling pair tricks would be faster; nine
 * plain taps are clearer and this is not the bottleneck.
 */
export const FRAG_BLUR = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uDirection;
uniform float uSigma;

void main() {
  float sigma = max(uSigma, 1e-3);
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);
  vec3 sum = texture(uSource, vUv).rgb;
  float wsum = 1.0;
  // Radius is fixed so the loop unrolls; taps beyond 3 sigma weigh nothing.
  for (int i = 1; i <= 8; i++) {
    float d = float(i);
    float w = exp(-d * d * inv2s2);
    if (w < 1e-4) break;
    sum += texture(uSource, vUv + uDirection * d).rgb * w;
    sum += texture(uSource, vUv - uDirection * d).rgb * w;
    wsum += 2.0 * w;
  }
  fragColor = vec4(sum / wsum, 1.0);
}
`;

/**
 * Pass 2c — recombination (eq. haladd).
 *
 * The pyramid levels are Gaussians of geometrically growing width; the host
 * fits their weights to the stock's exponential PSF plus its base-reflection
 * ring, per channel, so the red halo is wider than the blue one because the
 * transport says so, not because a parameter was tuned to make it look right.
 */
export const FRAG_HAL_COMBINE = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform sampler2D uL4;
uniform sampler2D uL5;
uniform sampler2D uL6;
// Per level, the weight for each of the three records.
uniform vec3 uW[7];
uniform vec3 uWeight;
// Dye transmission: how far the halo leans into the base's amber (the
// red-and-green mix of dye penetrating the base). Boost: the halo's
// saturation.
uniform float uTint;
uniform float uBoost;

void main() {
  vec3 e = texture(uScene, vUv).rgb;
  vec3 scattered =
      uW[0] * texture(uL0, vUv).r
    + uW[1] * texture(uL1, vUv).r
    + uW[2] * texture(uL2, vUv).r
    + uW[3] * texture(uL3, vUv).r
    + uW[4] * texture(uL4, vUv).r
    + uW[5] * texture(uL5, vUv).r
    + uW[6] * texture(uL6, vUv).r;

  // Dye transmission: the halo's colour collapses toward the base's own
  // amber transmission — red and green carried, blue suppressed — instead of
  // the transport's per-channel split.
  float lum = dot(scattered, vec3(0.2722, 0.6741, 0.0537));
  vec3 amber = lum * vec3(1.0, 0.58, 0.24);
  vec3 halo = mix(scattered, amber, uTint);

  // Boost: saturation of the halo about its own luminance.
  float hl = dot(halo, vec3(0.2722, 0.6741, 0.0537));
  halo = hl + (halo - hl) * (1.0 + uBoost);

  // Energy conserving: the scattered photons are removed from the direct path
  // and added back where they landed.
  vec3 outE = (1.0 - uWeight) * e + uWeight * halo;
  fragColor = vec4(max(outE, 0.0), 1.0);
}
`;

/**
 * Pass 4a — the developed negative density (§XV-E stages 1-3).
 *
 * Split out of the chain because what follows it is spatial: interlayer
 * inhibition reads a neighbourhood of this field, and a fragment shader cannot
 * read a neighbourhood of a value it is in the middle of computing.
 */
export const FRAG_NEGATIVE = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_NEGATIVE}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;

void main() {
  vec3 x = filmLogExposure(texture(uScene, vUv).rgb);
  fragColor = vec4(negativeDensity(x), 1.0);
}
`;

/**
 * Pass 4b — interlayer inhibition (§VIII, eq. interlayer).
 *
 *     D~ = D + L * A * (w1 (D - G_s1 * D) + w2 (D - G_s2 * D))
 *
 * The highpass is what makes this safe to apply on top of a measured
 * characteristic curve: a sensitometric strip is a uniform patch, H annihilates
 * constants, so the DC suppression the curve already contains is not applied a
 * second time. What survives is the part that only exists at edges — the
 * Eberhard rim, and the inter-image effect that makes a green region suppress
 * the red and blue beside it.
 *
 * L is the normalised point gamma, recomputed here from the scene rather than
 * carried in a texture: inhibitor release follows development activity, which
 * is nil in the toe and nil in the shoulder. That is what distinguishes this
 * from an unsharp mask, which sharpens a blown highlight with equal enthusiasm.
 */
export const FRAG_INTERLAYER = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_NEGATIVE}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uDensity;
uniform sampler2D uBlur1;
uniform sampler2D uBlur2;
uniform mat3  uCoupling;
uniform float uW1, uW2, uMu;

void main() {
  vec3 D  = texture(uDensity, vUv).rgb;
  vec3 b1 = texture(uBlur1, vUv).rgb;
  vec3 b2 = texture(uBlur2, vUv).rgb;

  vec3 H = uW1 * (D - b1) + uW2 * (D - b2);

  vec3 x = filmLogExposure(texture(uScene, vUv).rgb);
  vec3 lambda = pow(developmentActivity(x), vec3(uMu));

  fragColor = vec4(D + lambda * (uCoupling * H), 1.0);
}
`;

/**
 * The noise fields live in 8-bit targets, so a signed field has to be encoded.
 * The transform is affine, and a separable blur is linear, so blurring the
 * encoded values and decoding afterwards is identical to blurring the field
 * itself. At +/-4 sigma of headroom one quantisation step is 0.031 in a
 * unit-variance field, which reaches the density domain as 0.0006 — three
 * orders below anything a display can show.
 */
export const GLSL_NOISE_CODEC = /* glsl */ `
const float NOISE_SCALE = 0.125;
vec3 encodeNoise(vec3 n) { return n * NOISE_SCALE + 0.5; }
vec3 decodeNoise(vec3 v) { return (v - 0.5) / NOISE_SCALE; }
`;

/** Pass 3a — three independent unit-variance Gaussian white fields. */
export const FRAG_NOISE_WHITE = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_HASH}
${GLSL_NOISE_CODEC}
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uSize;
uniform uint uSeed;

void main() {
  uvec2 p = uvec2(vUv * uSize);
  uint base = pcg(p.x + 1973u * p.y + uSeed * 9277u);
  vec2 ab = gauss2(base);
  vec2 cd = gauss2(base ^ 0x85ebca6bu);
  fragColor = vec4(encodeNoise(vec3(ab.x, ab.y, cd.x)), 1.0);
}
`;

/** A straight copy, used when a stage is disabled so the graph keeps its shape. */
export const FRAG_COPY = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
void main() { fragColor = texture(uSource, vUv); }
`;

/**
 * Pass — taking-lens diffusion / veiling glare (§XIII, eq. diffusion).
 *
 *     E' = (1 - w_d) E + w_d [ (1 - rho) G_s1 * E + rho G_s2 * E ]
 *
 * A tight halo (s1) and a broad veil (s2), energy-conserving: the light that
 * scatters is removed from the direct path and added back where it lands. The
 * operation runs on linear scene exposure *before* the characteristic curve, so
 * a bright highlight contributes far more to the veil than a mid-tone — which
 * is what localises the lift around highlights without any threshold. Because
 * it is pre-exposure, the film's shoulder then compresses it, the restrained
 * look of a real diffusion filter rather than a post-hoc screen blend.
 */
export const FRAG_GLOW = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uTight;
uniform sampler2D uBroadTex;
uniform float uStrength;
uniform float uBroad;

void main() {
  vec3 e = texture(uScene, vUv).rgb;
  vec3 veil = (1.0 - uBroad) * texture(uTight, vUv).rgb
            + uBroad * texture(uBroadTex, vUv).rgb;
  vec3 outE = (1.0 - uStrength) * e + uStrength * veil;
  fragColor = vec4(max(outE, 0.0), 1.0);
}
`;

/**
 * Pass 3b — the grain kernel: a two-Gaussian mixture capturing the individual
 * grain and the tendency of grains to cluster. The host supplies the variance
 * normaliser so the field leaves this pass with unit variance, which is what
 * lets `uSigmaRef` in the chain be a real density in Selwyn units.
 */
export const FRAG_NOISE_COMBINE = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_NOISE_CODEC}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uNarrow;
uniform sampler2D uWide;
uniform float uChi;
uniform float uNormalise;
uniform mat3 uCholesky;

void main() {
  vec3 narrow = decodeNoise(texture(uNarrow, vUv).rgb);
  vec3 wide = decodeNoise(texture(uWide, vUv).rgb);
  vec3 z = mix(narrow, wide, uChi) * uNormalise;
  // n = L z reproduces the record correlation: independent crystal populations
  // give coloured grain, one silver image gives neutral grain.
  fragColor = vec4(encodeNoise(uCholesky * z), 1.0);
}
`;
