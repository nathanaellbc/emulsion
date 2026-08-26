import { GLSL_COMMON } from './common';

/**
 * The chain from the developed negative to the display — stages 4 to 9 of
 * §XV-E, plus the grain injection that has to happen before stage 4 because
 * grain is formed in the negative's density, not in the print's.
 *
 *   1-3                       upstream, in the negative and interlayer passes
 *   -  grain                  D += g * sigma_D(D) * n          (§XI)
 *   4  printing density       D_eff = C D
 *   5  print exposure         logE' = log L_aim + 0.025(p_c + p_master) - D_eff
 *   6  print curve            same form, print parameters
 *   7  silver retention       D' += rho * D_bar
 *   8  neutral axis           D'_R += d_RG psi, D'_B += d_BG psi
 *   9  display                normalise, surround, primaries
 *
 * Stages 1-3 left this shader when interlayer inhibition arrived: the operator
 * between stage 3 and grain is spatial, so the density has to exist as a
 * texture before it can be read. `uNegative` is that texture, inhibited if the
 * stock and the recipe call for it.
 */
export const FRAG_CHAIN = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uNegative;
uniform sampler2D uGrainField;

// --- the negative, for the stages that still read its shape ---
uniform vec3  uDMin, uDeltaD;
uniform bool  uReversal;

// --- grain ---
uniform bool  uGrainOn;
uniform float uGrainAmount, uSigmaRef, uNu1, uNu2, uNuPeak, uResponseGamma;

// --- subtractive grading: dye-density offsets on the print, and the master ---
uniform bool  uSubtractive;
uniform vec3  uSubCmy;
uniform float uSubDensity;
uniform int   uSubMode; // 0 suppress (neutral density in), 1 multiply (dyes thinned)

// --- print ---
uniform bool  uBypass;
uniform mat3  uCrosstalk;
uniform vec3  uPrintOffset;
uniform vec3  uPDMin, uPDeltaD, uPGamma, uPKappaT, uPKappaS;
uniform float uSilver, uSilverRange;
uniform vec3  uNeutralAxis;

// --- the measured print stock ---
// The LUT is indexed on the negative the way a film scanner delivers it:
// Cineon printing density, five hundred code values per density unit, the
// stock's own correctly exposed neutral at code 445. Output is Rec.709 at
// gamma 2.4, decoded here and handed to the shared output matrix.
uniform bool          uLutOn;
uniform highp sampler3D uPrintLut;
uniform vec3          uLutAnchor;   // the stock's own neutral density
uniform mat3          uSRGBToAP1;   // sRGB/709 primaries -> working space

// --- output ---
uniform mat3  uOutMatrix;
uniform float uSurround;

// --- inspection ---
// 0 print, 1 negative density, 2 print density, 3 halation source only.
uniform int   uViewMode;
uniform bool  uClipWarn;

const float NOISE_SCALE = 0.125;
vec3 decodeNoise(vec3 v) { return (v - 0.5) / NOISE_SCALE; }

vec3 printDensityAt(vec3 logEPrime) {
  vec3 u = uPGamma * logEPrime;
  return uPDMin + sp3(u, uPKappaT) - sp3(u - uPDeltaD, uPKappaS);
}

/// Selwyn granularity with the inverted-U density dependence of eq. grainvar,
/// generalised by the stock's shape exponents. The response bias
/// reparameterises p -> p^gamma: the shape stays normalised (its argument
/// still sweeps [0,1]) while the peak moves along the tone scale.
vec3 grainSigma(vec3 D) {
  vec3 p = clamp((D - uDMin) / uDeltaD, 0.0, 1.0);
  p = pow(p, vec3(uResponseGamma));
  vec3 shape = pow(p, vec3(uNu1)) * pow(1.0 - p, vec3(uNu2)) / max(uNuPeak, 1e-6);
  return uSigmaRef * sqrt(max(shape, 0.0));
}

void main() {
  if (uViewMode == 3) {
    vec3 e = max(texture(uScene, vUv).rgb, EXPOSURE_FLOOR);
    fragColor = vec4(oetf3(vec3(dot(vec3(0.2722, 0.6741, 0.0537), e) * 0.25)), 1.0);
    return;
  }

  // Stages 1-3, and interlayer inhibition, already ran.
  vec3 D = texture(uNegative, vUv).rgb;

  // Grain, in the density domain where it is formed.
  if (uGrainOn) {
    vec3 n = decodeNoise(texture(uGrainField, vUv).rgb);
    D += uGrainAmount * grainSigma(D) * n;
  }

  vec3 Y;
  if (uBypass) {
    // No transfer: invert and normalise only. For a negative this is the flat,
    // log-encoded look of an unadjusted lab scan; for a transparency, which is
    // viewed directly, it is the transmittance.
    vec3 t = clamp((D - uDMin) / uDeltaD, 0.0, 1.0);
    vec3 v = uReversal ? (1.0 - t) : t;
    Y = eotf3(v);
  } else if (uLutOn) {
    // The measured stock. The printer lights fold in as a density offset —
    // the measurement carries its own balance, so nothing else moves the
    // print before the table is read.
    vec3 dEff = D - uPrintOffset;
    vec3 cine = clamp((vec3(445.0) + 500.0 * (dEff - uLutAnchor)) / 1023.0, vec3(0.0), vec3(1.0));
    if (uViewMode == 2) {
      // Print D for a measured stock is the encoded print exposure itself:
      // the density the print layers receive, in Cineon code.
      fragColor = vec4(oetf3(cine), 1.0);
      return;
    }
    Y = uSRGBToAP1 * pow(texture(uPrintLut, cine).rgb, vec3(2.4));
  } else {
    // Stage 4.
    vec3 dEff = uCrosstalk * D;
    // Stage 5.
    vec3 logEPrime = uPrintOffset - dEff;
    // Stage 6.
    vec3 Dp = printDensityAt(logEPrime);
    // Stage 7 — silver is spectrally neutral, so it adds a neutral density on
    // top of the dye image. Desaturation is strongest in the shadows for free.
    if (uSilver > 0.0) {
      float bar = dot((Dp - uPDMin) / uPDeltaD, vec3(0.3333333)) * uSilverRange;
      Dp += uSilver * bar;
    }
    // Stage 8 — split toning expressed as an axis tilt, so it cannot produce a
    // non-monotone neutral.
    float psi = dot((Dp - uPDMin) / uPDeltaD, vec3(0.3333333)) - 0.5;
    Dp += uNeutralAxis * psi;

    if (uViewMode == 2) {
      fragColor = vec4(oetf3(Dp / max(uPDeltaD, vec3(1e-3))), 1.0);
      return;
    }

    // Stage 9 — subtracting the Dmax term matters: without it the print's
    // finite maximum density leaves a black that looks washed out on OLED.
    vec3 dMaxP = uPDMin + uPDeltaD;
    vec3 lo = exp10_3(-dMaxP);
    vec3 hi = exp10_3(-uPDMin);
    Y = (exp10_3(-Dp) - lo) / max(hi - lo, vec3(1e-9));
  }

  if (uViewMode == 1) {
    // Transmittance, on one common scale rather than per record. Normalising
    // each record against its own range would divide the orange mask straight
    // back out, and the mask is most of what there is to look at — the base
    // reads orange because Dmin is lowest in red, which is exactly the constant
    // vector the printer lights cancel in stage 5.
    vec3 T = exp10_3(-D);
    float base = pow(10.0, -min(uDMin.r, min(uDMin.g, uDMin.b)));
    fragColor = vec4(oetf3(clamp(T / max(base, 1e-6), 0.0, 1.0)), 1.0);
    return;
  }

  Y = max(Y, 0.0);

  // Subtractive grading: a dye-density offset is a transmittance multiply in
  // linear light, so the CMY bench and the density master act on Y here —
  // after the print, before the viewing condition, identically for either
  // engine. 'suppress' adds neutral density; 'multiply' thins the dyes,
  // and a dye scale of k is transmittance^k.
  if (uSubtractive && !uBypass) {
    Y *= exp10_3(-uSubCmy);
    if (uSubMode == 0) {
      Y *= exp10_3(vec3(-0.6 * uSubDensity));
    } else {
      Y = pow(Y, vec3(1.0 - uSubDensity));
    }
  }

  if (abs(uSurround - 1.0) > 1e-4) Y = pow(Y, vec3(uSurround));

  vec3 rgb = uOutMatrix * Y;
  vec3 encoded = oetf3(clamp(rgb, 0.0, 1.0));

  if (uClipWarn) {
    bool blown = rgb.r > 0.999 && rgb.g > 0.999 && rgb.b > 0.999;
    bool crushed = rgb.r < 0.0008 && rgb.g < 0.0008 && rgb.b < 0.0008;
    if (blown) encoded = vec3(0.95, 0.25, 0.15);
    else if (crushed) encoded = vec3(0.15, 0.35, 0.9);
  }

  fragColor = vec4(encoded, 1.0);
}
`;

/**
 * The split-view comparison pass. Kept separate from the chain so the "before"
 * side is the decoded source rendered honestly, not the chain with its
 * parameters neutralised — which would still be film, just flat film.
 */
export const FRAG_COMPOSITE = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uProcessed;
uniform sampler2D uScene;
uniform mat3 uOutMatrix;
uniform float uSplit;
uniform float uAspectPx;

void main() {
  if (vUv.x > uSplit) {
    fragColor = vec4(texture(uProcessed, vUv).rgb, 1.0);
  } else {
    // The unprocessed side: working space straight to display, no film at all.
    vec3 lin = uOutMatrix * texture(uScene, vUv).rgb;
    fragColor = vec4(oetf3(clamp(lin, 0.0, 1.0)), 1.0);
  }
  // A one-pixel seam so the boundary is legible against any image.
  if (abs(vUv.x - uSplit) < uAspectPx) fragColor = vec4(0.88, 0.55, 0.24, 1.0);
}
`;
