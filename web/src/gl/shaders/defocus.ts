import { GLSL_COMMON } from './common';

/**
 * Synthetic defocus (§XIII) — scatter-as-gather at half resolution, with the
 * near and far fields kept apart.
 *
 *   scene ─┬─ prep (½) ── mips ─┬─ far gather (½) ──┐
 *   depth ─┘      └─ tiles ── dilate ── near gather (½) ─┴─ combine (1) ─ lens out
 *
 * Every pass works in the scene-linear light the prepare pass produced, before
 * glow and halation: the lens forms the image before the film sees it, so a
 * defocused highlight reaches the negative as a bright disc and the shoulder
 * and the halation act on the disc — not the other way round, as a post-hoc
 * blur on a finished print would have it.
 *
 * "Scatter as gather": physically every point spreads into its own disc. A
 * gather inverts that — at each pixel, visit neighbours and ask whose disc
 * covers this pixel — which a fragment shader can do and a scatter it cannot.
 * Each covering neighbour is weighted by the inverse of its disc's area, so a
 * point light keeps its energy however wide it spreads: a small bright
 * highlight becomes a large, dimmer, uniformly lit disc, not a smear.
 *
 * Two fields, because occlusion is not symmetric:
 *  - behind the focal plane, a neighbour may spread over this pixel only as
 *    far as this pixel's own blur allows — a sharp subject is never painted
 *    over by the soft background behind it;
 *  - in front of it, a blurred foreground spreads over everything, sharp
 *    subject included, which is why its discs are gathered separately (with a
 *    reach dilated from 16-pixel tiles) and laid over the top with coverage.
 *
 * The technique follows the post-process depth of field of Jimenez (Next
 * Generation Post Processing in Call of Duty: Advanced Warfare, 2014) and
 * GPU Gems 3 ch. 28; the CoC is the paper's thin-lens formula, and the blur
 * shape is the aperture's.
 */

/** Tile edge in grid pixels, for the foreground's reach. */
export const DOF_TILE = 16;
/** The gather grid's long edge never exceeds this (see FRAG_DOF_PREP). */
export const DOF_MAX_EDGE = 1536;
/** Most samples one gather takes; the reach sets how many of them it needs. */
export const DOF_MAX_SAMPLES = 256;

const GLSL_DOF = /* glsl */ `
const float PI = 3.141592653589793;
const float GOLDEN_ANGLE = 2.399963229728653;
const float MIN_FOCUS_DISPARITY = 0.02;
const int MAX_SAMPLES = ${DOF_MAX_SAMPLES};
// Target spacing between gather samples, grid pixels. Wider discs spend
// the fixed budget more sparsely and prefilter to match (see sampleLod).
const float SAMPLE_SPACING = 1.6;
// Discs smaller than this (grid-pixel radius) are not the grid's business:
// the combine blurs them at full resolution, where they belong, and the near
// field starts beyond it.
const float GRID_MIN_RADIUS = 1.0;

uniform sampler2D uDepth;
uniform bool  uDepthFlip;
uniform float uFocusDisparity;
uniform float uCocScale;   // CoC diameter of a subject at infinity, render px
uniform float uMaxCoc;     // largest diameter drawn, render px

/// The depth map is in the source texture's row order; the scene is not.
float disparityAt(vec2 uv) {
  return texture(uDepth, uDepthFlip ? vec2(uv.x, 1.0 - uv.y) : uv).r;
}

/// Signed CoC diameter in render pixels: + behind the focal plane, - in front
/// (core/defocus.ts, signedCocPx).
float signedCoc(float d) {
  float df = max(uFocusDisparity, MIN_FOCUS_DISPARITY);
  return clamp(uCocScale * (1.0 - d / df), -uMaxCoc, uMaxCoc);
}
`;

/**
 * The aperture. `v` is the offset from a disc's centre to the point asked
 * about, in grid pixels; `r` the disc's radius. Returns a signed distance
 * to the disc's edge in pixels, positive inside — clamped to [0, 1] after a
 * half-pixel shift it is an antialiased coverage.
 *
 * Blades: an n-gon inscribed in the circle, blended toward the circle by the
 * blade curvature. Cat-eye (optical vignetting): the exit pupil seen from off
 * axis is cut by the barrel, modelled as §XIII has it — the intersection of
 * two circles offset along the radial direction, which flattens the disc
 * radially into a lemon at the frame's edge and leaves it round at the centre.
 */
const GLSL_APERTURE = /* glsl */ `
uniform int   uBlades;     // 0 is round
uniform float uCurvature;  // 0 straight blades, 1 round
uniform float uCatEye;     // 0 none
uniform vec2  uAspect;     // image extent, normalised so the corner is at length 1

float apertureEdge(vec2 v, float r, vec2 radialDir, float catOffset) {
  float len = length(v);
  float edge = r;
  if (uBlades >= 5) {
    float n = float(uBlades);
    float seg = 2.0 * PI / n;
    float a = atan(v.y, v.x) + PI * 0.5;
    float t = mod(a, seg) - 0.5 * seg;
    float poly = cos(PI / n) / cos(t);
    edge = r * mix(poly, 1.0, uCurvature);
  }
  float d = edge - len;
  if (catOffset > 0.0) {
    vec2 c = radialDir * (0.5 * catOffset * r);
    d = min(d, min(r - length(v - c), r - length(v + c)));
  }
  return d;
}

/// Where this pixel sits in the frame: the radial direction and how hard the
/// barrel cuts the pupil here (0 at the centre, uCatEye at the corners).
void catEyeAt(vec2 uv, out vec2 dir, out float offset) {
  vec2 p = (uv - 0.5) * 2.0 * uAspect;
  float rr = length(p);
  dir = rr > 1e-5 ? p / rr : vec2(1.0, 0.0);
  offset = uCatEye * 1.2 * rr * rr;
}

/// Vogel's golden-angle spiral: N points of equal area in the unit disc.
vec2 vogel(int k, int n) {
  float rho = sqrt((float(k) + 0.5) / float(n));
  float th = float(k) * GOLDEN_ANGLE;
  return rho * vec2(cos(th), sin(th));
}

int sampleCount(float reach) {
  float n = ceil(PI * reach * reach / (SAMPLE_SPACING * SAMPLE_SPACING));
  return int(clamp(n, 8.0, float(MAX_SAMPLES)));
}

/// A sparse gather would miss a small bright point between its samples; each
/// sample instead reads a mip level as wide as the spacing, which keeps the
/// point's energy — but never wider than the disc it stands for.
float sampleLod(float spacing, float r) {
  return max(log2(max(min(spacing, r), 1.0)), 0.0);
}
`;

/**
 * The gather's working grid: half resolution, but never more than
 * DOF_MAX_EDGE on the long side. Blur is low-frequency by definition, so a
 * large export gathers on the same grid a preview does — the cost and the
 * look stay the same at 2048 and at 8192, and the full-resolution combine
 * keeps every in-focus pixel at full resolution regardless.
 *
 * Each grid cell is the box average of the scene pixels it covers (uTaps² bilinear
 * taps, each itself a 2×2 average), and alpha carries the signed CoC
 * *radius* in grid pixels.
 */
export const FRAG_DOF_PREP = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_DOF}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform float uGridScale;   // grid pixels per render pixel
uniform int uTaps;          // bilinear taps per axis
void main() {
  vec2 cell = 1.0 / vec2(textureSize(uScene, 0)) / uGridScale;
  vec3 c = vec3(0.0);
  for (int y = 0; y < 8; y++) {
    if (y >= uTaps) break;
    for (int x = 0; x < 8; x++) {
      if (x >= uTaps) break;
      vec2 f = (vec2(float(x), float(y)) + 0.5) / float(uTaps) - 0.5;
      c += texture(uScene, vUv + f * cell).rgb;
    }
  }
  c /= float(uTaps * uTaps);
  float coc = signedCoc(disparityAt(vUv));
  fragColor = vec4(c, coc * 0.5 * uGridScale);
}
`;

/**
 * Per 16×16 tile of the grid field: the widest foreground disc in it
 * (red), and the widest disc of any kind (green).
 */
export const FRAG_DOF_TILE = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uHalf;
const int TILE = ${DOF_TILE};
void main() {
  ivec2 size = textureSize(uHalf, 0);
  ivec2 base = ivec2(gl_FragCoord.xy) * TILE;
  float nearMax = 0.0;
  float anyMax = 0.0;
  for (int y = 0; y < TILE; y++) {
    for (int x = 0; x < TILE; x++) {
      ivec2 p = min(base + ivec2(x, y), size - 1);
      float c = texelFetch(uHalf, p, 0).a;
      nearMax = max(nearMax, -c);
      anyMax = max(anyMax, abs(c));
    }
  }
  fragColor = vec4(nearMax, anyMax, 0.0, 1.0);
}
`;

/**
 * Dilates the foreground reach: a tile inherits a neighbour's foreground disc
 * if that disc can reach into it. A blurred foreground spreads *outward* past
 * its own silhouette, and this is where the gather learns to look for it.
 */
export const FRAG_DOF_DILATE = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTiles;
uniform int uReach;   // tiles
const int MAX_REACH = 8;
const float TILE = ${DOF_TILE}.0;
void main() {
  ivec2 size = textureSize(uTiles, 0);
  ivec2 me = ivec2(gl_FragCoord.xy);
  vec4 own = texelFetch(uTiles, me, 0);
  float nearMax = own.r;
  for (int y = -MAX_REACH; y <= MAX_REACH; y++) {
    if (abs(y) > uReach) continue;
    for (int x = -MAX_REACH; x <= MAX_REACH; x++) {
      if (abs(x) > uReach) continue;
      ivec2 q = me + ivec2(x, y);
      if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size))) continue;
      float r = texelFetch(uTiles, q, 0).r;
      // The gap between the two tiles' nearest edges, in grid pixels.
      float gap = float(max(max(abs(x), abs(y)) - 1, 0)) * TILE;
      if (r >= gap) nearMax = max(nearMax, r);
    }
  }
  fragColor = vec4(nearMax, own.g, 0.0, 1.0);
}
`;

/**
 * The focal plane and everything behind it. A neighbour spreads over this
 * pixel only within min(its radius, this pixel's radius): the smaller of the
 * two blurs decides, so nothing soft is ever painted across something sharp.
 * Foreground samples are skipped entirely — the near gather owns them — which
 * also means that behind a blurred foreground this pass reconstructs the
 * background from its unoccluded neighbours, for the foreground's translucent
 * rim to reveal.
 */
export const FRAG_DOF_FAR = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_DOF}
${GLSL_APERTURE}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uHalf;

void main() {
  ivec2 size = textureSize(uHalf, 0);
  vec2 texel = 1.0 / vec2(size);
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec4 centre = texelFetch(uHalf, ip, 0);
  float rc = abs(centre.a);
  if (rc < 0.5) {
    fragColor = vec4(centre.rgb, 1.0);
    return;
  }
  vec2 radialDir;
  float catOffset;
  catEyeAt(vUv, radialDir, catOffset);

  int n = sampleCount(rc);
  float spacing = sqrt(PI * rc * rc / float(n));
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int k = 0; k < MAX_SAMPLES; k++) {
    if (k >= n) break;
    vec2 o = vogel(k, n) * rc;
    vec2 suv = vUv + o * texel;
    float cs = texelFetch(uHalf, clamp(ivec2(floor(suv * vec2(size))), ivec2(0), size - 1), 0).a;
    if (cs < -GRID_MIN_RADIUS) continue;
    float r = min(abs(cs), rc);
    // The sample's disc is centred on the sample; this pixel is at -o from it.
    float cov = clamp(apertureEdge(-o, r, radialDir, catOffset) + 0.5, 0.0, 1.0);
    if (cov <= 0.0) continue;
    float w = cov / (PI * max(r * r, 0.25));
    sum += textureLod(uHalf, suv, sampleLod(spacing, r)).rgb * w;
    wsum += w;
  }
  fragColor = vec4(wsum > 0.0 ? sum / wsum : centre.rgb, 1.0);
}
`;

/**
 * In front of the focal plane: blurred foreground discs, gathered over the
 * dilated tile reach and returned with their coverage in alpha — the fraction
 * of this pixel the foreground's discs cover, which is how translucently they
 * lie over the far field. Written premultiplied by that coverage.
 */
export const FRAG_DOF_NEAR = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_DOF}
${GLSL_APERTURE}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uHalf;
uniform sampler2D uTiles;
const int TILE = ${DOF_TILE};

void main() {
  ivec2 size = textureSize(uHalf, 0);
  vec2 texel = 1.0 / vec2(size);
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float reach = texelFetch(uTiles, ip / TILE, 0).r;
  if (reach < 0.5) {
    fragColor = vec4(0.0);
    return;
  }
  vec2 radialDir;
  float catOffset;
  catEyeAt(vUv, radialDir, catOffset);

  int n = sampleCount(reach);
  float spacing = sqrt(PI * reach * reach / float(n));
  float sampleArea = PI * reach * reach / float(n);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  float coverage = 0.0;

  // This pixel's own disc covers it completely, whatever the tile's reach.
  float cc = texelFetch(uHalf, ip, 0).a;
  if (cc < -GRID_MIN_RADIUS) {
    float r = -cc;
    float w = 1.0 / (PI * r * r);
    sum += textureLod(uHalf, vUv, sampleLod(spacing, r)).rgb * w;
    wsum += w;
    coverage = clamp(r - GRID_MIN_RADIUS, 0.0, 1.0);
  }

  for (int k = 0; k < MAX_SAMPLES; k++) {
    if (k >= n) break;
    vec2 o = vogel(k, n) * reach;
    vec2 suv = vUv + o * texel;
    float cs = texelFetch(uHalf, clamp(ivec2(floor(suv * vec2(size))), ivec2(0), size - 1), 0).a;
    if (cs >= -GRID_MIN_RADIUS) continue;
    float r = -cs;
    float cov = clamp(apertureEdge(-o, r, radialDir, catOffset) + 0.5, 0.0, 1.0);
    if (cov <= 0.0) continue;
    float w = cov / (PI * r * r);
    sum += textureLod(uHalf, suv, sampleLod(spacing, r)).rgb * w;
    wsum += w;
    coverage += cov * sampleArea / (PI * r * r);
  }
  // Premultiplied, so the upsample's tent can average it across the rim.
  float a = clamp(coverage, 0.0, 1.0);
  fragColor = wsum > 0.0 ? vec4(sum / wsum * a, a) : vec4(0.0);
}
`;

/**
 * Back to full resolution. Where the CoC is under half a pixel the scene is
 * taken as it was; up to a grid pixel or so it is blurred here, at full
 * resolution, with a small disc — the depth of field's own margins, which a
 * grid pixel (itself two render pixels wide) would soften past what the lens
 * does. Only beyond that does the gathered field take over. The CoC is read
 * from the depth map directly, so the in-focus boundary is as sharp as the
 * depth map's edges. The foreground is laid over the top by coverage.
 * The grid fields are read through a 2×2 tent (four bilinear taps), which
 * dissolves what the finite sample pattern leaves behind.
 */
export const FRAG_DOF_COMBINE = /* glsl */ `#version 300 es
${GLSL_COMMON}
${GLSL_DOF}
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uFar;
uniform sampler2D uNear;
uniform float uGridScale;   // grid pixels per render pixel

const int SMALL_TAPS = 16;

/// A uniform disc of radius r render pixels, bilinear taps on a golden spiral.
vec3 smallDisc(vec2 uv, float r) {
  vec2 texel = 1.0 / vec2(textureSize(uScene, 0));
  vec3 sum = vec3(0.0);
  for (int k = 0; k < SMALL_TAPS; k++) {
    float rho = sqrt((float(k) + 0.5) / float(SMALL_TAPS));
    float th = float(k) * GOLDEN_ANGLE;
    sum += texture(uScene, uv + rho * r * vec2(cos(th), sin(th)) * texel).rgb;
  }
  return sum / float(SMALL_TAPS);
}

vec4 tent(sampler2D t, vec2 uv) {
  vec2 h = 0.5 / vec2(textureSize(t, 0));
  return 0.25 * (texture(t, uv + vec2(-h.x, -h.y)) + texture(t, uv + vec2(h.x, -h.y))
               + texture(t, uv + vec2(-h.x,  h.y)) + texture(t, uv + vec2(h.x,  h.y)));
}

void main() {
  vec3 sharp = texture(uScene, vUv).rgb;
  float r = abs(signedCoc(disparityAt(vUv))) * 0.5;
  float cell = GRID_MIN_RADIUS / uGridScale;   // the grid's threshold, in render px
  vec3 small = r < 0.5 ? sharp : smallDisc(vUv, min(r, 2.0 * cell));
  vec3 far = tent(uFar, vUv).rgb;
  vec3 base = mix(small, far, smoothstep(cell, 2.0 * cell, r));
  vec4 near = tent(uNear, vUv);
  fragColor = vec4(max(base * (1.0 - near.a) + near.rgb, 0.0), 1.0);
}
`;

export const GLSL_DOF_FOR_COMPOSITE = GLSL_DOF;
