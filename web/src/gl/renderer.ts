/**
 * The render graph (§XVI).
 *
 *   source -> prepare -> [halation] -> negative -> [interlayer] -> chain -> canvas
 *                            |                          |
 *                    source term -> pyramid      D, and two blurs of it
 *                            |                          |
 *                        recombine                   combine
 *
 * Every intermediate is float: the chain works in density, and density is not
 * an 8-bit quantity. The one 8-bit surface is the grain field, where a
 * unit-variance noise field quantised to 256 steps contributes about 0.0006
 * density of error — three orders below anything visible.
 */

import { AP1_LUMINANCE, M_SRGB_TO_AP1 } from '../core/colorspace';
import { developIsIdentity } from '../core/develop';
import type { CubeLut } from '../core/cube';
import type { ResolvedParameters } from '../core/resolve';
import { matToGL, triToGL } from '../core/triple';
import {
  Program,
  bindTarget,
  createContext,
  createTarget,
  disposeTarget,
  drawFullscreen,
  type Target,
} from './context';
import { PYRAMID_LEVELS, LEVEL_SIGMA, RING_RADIUS_UM, pyramidWeightArray } from './halationFit';
import { FRAG_CHAIN, FRAG_COMPOSITE } from './shaders/chain';
import {
  FRAG_BLUR,
  FRAG_COPY,
  FRAG_DOWNSAMPLE,
  FRAG_GLOW,
  FRAG_HAL_COMBINE,
  FRAG_HAL_SOURCE,
  FRAG_INTERLAYER,
  FRAG_NEGATIVE,
  FRAG_NOISE_COMBINE,
  FRAG_NOISE_WHITE,
  FRAG_PREPARE,
} from './shaders/passes';

export type ViewMode = 'print' | 'negative' | 'printDensity' | 'halationSource';

export interface ViewOptions {
  mode: ViewMode;
  /** 0 disables the comparison; otherwise the seam position in [0,1]. */
  split: number;
  clipWarning: boolean;
}

export interface SourceImage {
  width: number;
  height: number;
  /** Either a bitmap (already 8-bit, display encoded) or float RGB from a RAW decode. */
  bitmap?: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  float?: Float32Array;
  /** True when the values still carry a display transfer function. */
  encoded: boolean;
}

const VIEW_MODE_CODE: Record<ViewMode, number> = {
  print: 0,
  negative: 1,
  printDensity: 2,
  halationSource: 3,
};

/** Working resolution cap. Above this the passes cost more than they show. */
export const PREVIEW_MAX_WIDTH = 2048;
export const EXPORT_MAX_WIDTH = 4096;

interface GrainCacheKey {
  seed: number;
  sigma1: number;
  sigma2: number;
  chi: number;
  chol: string;
  width: number;
  height: number;
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly programs: Record<string, Program>;

  private sourceTex: WebGLTexture | null = null;
  private sourceW = 0;
  private sourceH = 0;
  private sourceEncoded = true;
  private sourceFlipY = false;

  private width = 0;
  private height = 0;

  private scene: Target | null = null;
  private halScene: Target | null = null;
  /** The glow stage's tight and broad convolutions, plus its output. */
  private glowTight: Target | null = null;
  private glowBroad: Target | null = null;
  private glowBroadTemp: Target | null = null;
  private glowTemp: Target | null = null;
  private glowOut: Target | null = null;
  /** Per level: the downsampled source, a ping buffer, and the blurred result. */
  private halSrc: Target[] = [];
  private halTemps: Target[] = [];
  private halLevels: Target[] = [];
  private negative: Target | null = null;
  /** Allocated on first use: three more full-resolution float surfaces is not
   * a cost to pay for a stock or a recipe that has the stage switched off. */
  private ilBlur1: Target | null = null;
  private ilBlur2: Target | null = null;
  private ilScratch: Target | null = null;
  private noiseA: Target | null = null;
  private noiseB: Target | null = null;
  private noiseNarrow: Target | null = null;
  private noiseWide: Target | null = null;
  private grainField: Target | null = null;
  private processed: Target | null = null;

  private grainKey: string | null = null;

  /** The measured print stock's table, and the stock it was uploaded for. */
  private printLutTex: WebGLTexture | null = null;
  private printLutId: string | null = null;
  /** A one-node table for the frames before a LUT arrives: an active
   * sampler3D uniform with a 2D texture (or nothing) on its unit makes the
   * whole draw invalid, so the chain always has *something* legal to read. */
  private printLutDummy: WebGLTexture | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas);
    const gl = this.gl;
    this.programs = {
      prepare: new Program(gl, FRAG_PREPARE, 'prepare'),
      halSource: new Program(gl, FRAG_HAL_SOURCE, 'halation source'),
      downsample: new Program(gl, FRAG_DOWNSAMPLE, 'downsample'),
      blur: new Program(gl, FRAG_BLUR, 'blur'),
      halCombine: new Program(gl, FRAG_HAL_COMBINE, 'halation recombine'),
      glow: new Program(gl, FRAG_GLOW, 'taking-lens diffusion'),
      negative: new Program(gl, FRAG_NEGATIVE, 'negative density'),
      interlayer: new Program(gl, FRAG_INTERLAYER, 'interlayer inhibition'),
      copy: new Program(gl, FRAG_COPY, 'copy'),
      noiseWhite: new Program(gl, FRAG_NOISE_WHITE, 'grain white field'),
      noiseCombine: new Program(gl, FRAG_NOISE_COMBINE, 'grain kernel'),
      chain: new Program(gl, FRAG_CHAIN, 'pointwise chain'),
      composite: new Program(gl, FRAG_COMPOSITE, 'composite'),
    };
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  get renderWidth() {
    return this.width;
  }

  get renderHeight() {
    return this.height;
  }

  /**
   * The largest surface this context can allocate, in either dimension. The
   * export dialog offers resolution detents up to this and no further: a
   * render above it fails at allocation, and the failure mode worth having is
   * the option never appearing, not the export dying mid-flight.
   */
  get maxTextureSize() {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  get hasSource() {
    return this.sourceTex !== null;
  }

  /**
   * Uploads a measured print stock as a 3D texture, once per stock. RGBA16F
   * rather than 8-bit: the table is effectively ten bits of film response,
   * and an 8-bit copy would band the print's toe before the film ever did.
   * The node order parses red-fastest, which is texImage3D's order, so the
   * array goes up as it arrived.
   */
  setPrintLut(lut: CubeLut | null, id: string) {
    const gl = this.gl;
    if (!this.printLutDummy) {
      const dummy = gl.createTexture();
      if (!dummy) throw new Error('could not allocate the print LUT placeholder');
      const zero = new Uint16Array([0, 0, 0, 0x3c00]);
      gl.bindTexture(gl.TEXTURE_3D, dummy);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, zero);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      this.printLutDummy = dummy;
    }
    if (!lut || !id) {
      if (this.printLutTex) {
        gl.deleteTexture(this.printLutTex);
        this.printLutTex = null;
        this.printLutId = null;
      }
      return;
    }
    if (this.printLutId === id && this.printLutTex) return;
    if (this.printLutTex) gl.deleteTexture(this.printLutTex);

    const tex = gl.createTexture();
    if (!tex) throw new Error('could not allocate the print LUT texture');
    const rgba = new Uint16Array(lut.size * lut.size * lut.size * 4);
    for (let i = 0, j = 0; i < lut.data.length; i += 3) {
      rgba[j++] = floatToHalf(lut.data[i]!);
      rgba[j++] = floatToHalf(lut.data[i + 1]!);
      rgba[j++] = floatToHalf(lut.data[i + 2]!);
      rgba[j++] = 0x3c00; // 1.0 in half floats
    }
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0,
      gl.RGBA, gl.HALF_FLOAT, rgba,
    );
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.printLutTex = tex;
    this.printLutId = id;
  }

  /** Uploads a decoded image and sizes the graph to it. */
  setSource(image: SourceImage, maxWidth = PREVIEW_MAX_WIDTH) {
    const gl = this.gl;
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);

    const tex = gl.createTexture();
    if (!tex) throw new Error('could not allocate the source texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    if (image.float) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, image.width, image.height, 0,
        gl.RGBA, gl.FLOAT, image.float,
      );
    } else if (image.bitmap) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image.bitmap);
    } else {
      throw new Error('source image carries neither pixels nor a bitmap');
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.sourceTex = tex;
    this.sourceW = image.width;
    this.sourceH = image.height;
    this.sourceEncoded = image.encoded;
    // A DOM image or bitmap arrives with its origin top-left; float data we
    // decoded ourselves is already in texture order.
    this.sourceFlipY = !image.float;

    const scale = Math.min(1, maxWidth / image.width);
    this.allocate(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  }

  /** Reallocates every intermediate for a new working resolution. */
  private allocate(width: number, height: number) {
    const gl = this.gl;
    if (this.width === width && this.height === height && this.scene) return;
    this.releaseTargets();
    this.width = width;
    this.height = height;

    this.scene = createTarget(gl, width, height, gl.RGBA16F);
    this.halScene = createTarget(gl, width, height, gl.RGBA16F);
    // The glow's broad veil is separable and heavy-tailed; run it at half
    // resolution, which is invisible for a veil this wide and four times cheaper.
    this.glowTight = createTarget(gl, width, height, gl.RGBA16F);
    this.glowTemp = createTarget(gl, width, height, gl.RGBA16F);
    const hw = Math.max(1, width >> 1);
    const hh = Math.max(1, height >> 1);
    this.glowBroad = createTarget(gl, hw, hh, gl.RGBA16F);
    this.glowBroadTemp = createTarget(gl, hw, hh, gl.RGBA16F);
    this.glowOut = createTarget(gl, width, height, gl.RGBA16F);
    this.negative = createTarget(gl, width, height, gl.RGBA16F);
    this.processed = createTarget(gl, width, height, gl.RGBA8);

    this.halSrc = [];
    this.halTemps = [];
    this.halLevels = [];
    for (let j = 0; j < PYRAMID_LEVELS; j++) {
      const w = Math.max(1, width >> j);
      const h = Math.max(1, height >> j);
      this.halSrc.push(createTarget(gl, w, h, gl.R16F));
      this.halTemps.push(createTarget(gl, w, h, gl.R16F));
      this.halLevels.push(createTarget(gl, w, h, gl.R16F));
    }

    this.noiseA = createTarget(gl, width, height, gl.RGBA8);
    this.noiseB = createTarget(gl, width, height, gl.RGBA8);
    this.noiseNarrow = createTarget(gl, width, height, gl.RGBA8);
    this.noiseWide = createTarget(gl, width, height, gl.RGBA8);
    this.grainField = createTarget(gl, width, height, gl.RGBA8);
    this.grainKey = null;
  }

  private releaseTargets() {
    const gl = this.gl;
    const all = [
      this.scene, this.halScene, this.negative, this.processed,
      this.glowTight, this.glowBroad, this.glowBroadTemp, this.glowTemp, this.glowOut,
      this.ilBlur1, this.ilBlur2, this.ilScratch,
      this.noiseA, this.noiseB, this.noiseNarrow, this.noiseWide, this.grainField,
      ...this.halSrc, ...this.halTemps, ...this.halLevels,
    ];
    for (const t of all) if (t) disposeTarget(gl, t);
    this.scene = this.halScene = this.negative = this.processed = null;
    this.glowTight = this.glowBroad = this.glowBroadTemp = this.glowTemp = this.glowOut = null;
    this.ilBlur1 = this.ilBlur2 = this.ilScratch = null;
    this.noiseA = this.noiseB = this.noiseNarrow = this.noiseWide = this.grainField = null;
    this.halSrc = [];
    this.halTemps = [];
    this.halLevels = [];
  }

  /** Separable Gaussian, `src` into `dst` via `temp`. */
  private blur(src: Target, temp: Target, dst: Target, sigma: number) {
    const gl = this.gl;
    const p = this.programs.blur!;
    p.use();
    bindTarget(gl, temp);
    p.texture('uSource', 0, src.texture).float('uSigma', sigma).vec2('uDirection', 1 / src.width, 0);
    drawFullscreen(gl);
    bindTarget(gl, dst);
    p.texture('uSource', 0, temp.texture).float('uSigma', sigma).vec2('uDirection', 0, 1 / temp.height);
    drawFullscreen(gl);
  }

  /**
   * Taking-lens diffusion (§XIII). Convolves the linear scene into a tight halo
   * and a broad veil, then recombines them energy-conserving before the film is
   * exposed. Runs on `scene` and leaves the result in `glowOut`, which the rest
   * of the graph reads in place of the raw scene; disabled, it is a straight
   * copy so the graph keeps its shape.
   */
  private runGlow(params: ResolvedParameters) {
    const gl = this.gl;
    const g = params.glow;
    const scene = this.scene!;
    const out = this.glowOut!;

    if (!g.enabled) {
      const p = this.programs.copy!.use();
      bindTarget(gl, out);
      p.texture('uSource', 0, scene.texture);
      drawFullscreen(gl);
      return;
    }

    // Tight halo at full resolution.
    this.blur(scene, this.glowTemp!, this.glowTight!, g.sigma1Px);

    // Broad veil: downsample, blur at half resolution with the wide sigma
    // (halved for the smaller grid), so the long tail is affordable.
    const down = this.programs.downsample!.use();
    bindTarget(gl, this.glowBroad!);
    down.texture('uSource', 0, this.glowTight!.texture)
      .vec2('uSourceTexel', 1 / this.glowTight!.width, 1 / this.glowTight!.height);
    drawFullscreen(gl);
    // Blur the broad target via its own half-size temp, at the wide sigma
    // (halved for the smaller grid).
    this.blur(this.glowBroad!, this.glowBroadTemp!, this.glowBroad!, g.sigma2Px * 0.5);

    const comb = this.programs.glow!.use();
    bindTarget(gl, out);
    comb
      .texture('uScene', 0, scene.texture)
      .texture('uTight', 1, this.glowTight!.texture)
      .texture('uBroadTex', 2, this.glowBroad!.texture)
      .float('uStrength', g.strength)
      .float('uBroad', g.broad);
    drawFullscreen(gl);
  }

  private runHalation(params: ResolvedParameters) {
    const gl = this.gl;
    const { halation } = params;
    // Halation scatters light that has already passed the taking lens, so it
    // reads the diffused scene, not the raw one.
    const scene = this.glowOut!;
    const dst = this.halScene!;

    if (!halation.enabled) {
      // Straight copy, so the chain always reads the same texture.
      const p = this.programs.copy!.use();
      bindTarget(gl, dst);
      p.texture('uSource', 0, scene.texture);
      drawFullscreen(gl);
      return;
    }

    // Source term at full resolution, into level 0's unblurred slot.
    const src = this.programs.halSource!.use();
    bindTarget(gl, this.halSrc[0]!);
    src
      .texture('uScene', 0, scene.texture)
      .vec3('uLuminance', triToGL(AP1_LUMINANCE))
      .float('uThreshold', halation.threshold)
      .float('uKnee', halation.kneeSoftness);
    drawFullscreen(gl);

    // A proper Gaussian pyramid: blur, then halve the blurred result, so each
    // downsample is band-limited before it is decimated.
    this.blur(this.halSrc[0]!, this.halTemps[0]!, this.halLevels[0]!, LEVEL_SIGMA);
    const down = this.programs.downsample!;
    for (let j = 1; j < PYRAMID_LEVELS; j++) {
      const prev = this.halLevels[j - 1]!;
      down.use();
      bindTarget(gl, this.halSrc[j]!);
      down.texture('uSource', 0, prev.texture).vec2('uSourceTexel', 1 / prev.width, 1 / prev.height);
      drawFullscreen(gl);
      this.blur(this.halSrc[j]!, this.halTemps[j]!, this.halLevels[j]!, LEVEL_SIGMA);
    }

    // Recover the pixel pitch from the resolved length so the ring radius,
    // which is a property of the base and not of the emulsion, stays physical.
    const pitchUm =
      (params.negative.halation.lengthRedUm * params.recipe.halation.radius) /
      Math.max(halation.lengthPx[0], 1e-6);
    const ringPx = RING_RADIUS_UM / Math.max(pitchUm, 1e-6);
    const weights = pyramidWeightArray(halation.lengthPx, halation.omega, ringPx);

    const comb = this.programs.halCombine!.use();
    bindTarget(gl, dst);
    comb.texture('uScene', 0, scene.texture);
    for (let j = 0; j < PYRAMID_LEVELS; j++) {
      comb.texture(`uL${j}`, 1 + j, this.halLevels[j]!.texture);
    }
    comb.vec3Array('uW[0]', weights).vec3('uWeight', triToGL(halation.weight));
    comb.float('uTint', halation.tint).float('uBoost', halation.boost);
    drawFullscreen(gl);
  }

  /**
   * The uniforms of stages 1-3. Set on both programs that evaluate them: the
   * negative pass, which produces the density, and the interlayer pass, which
   * recomputes the log exposure to know how much inhibitor each pixel released.
   */
  private setNegativeUniforms(p: Program, params: ResolvedParameters) {
    const c = params.curve;
    p.float('uAnchorShift', params.anchorShift)
      .vec3('uBalanceShift', triToGL(params.balanceShift))
      .int('uMono', params.monochrome ? 1 : 0)
      .vec3('uPan', triToGL(params.panWeights))
      .vec3('uDMin', triToGL(c.dMin))
      .vec3('uDeltaD', triToGL(c.deltaD))
      .vec3('uGamma', triToGL(c.gamma))
      .vec3('uX0', triToGL(c.x0))
      .vec3('uKappaT', triToGL(c.kappaT))
      .vec3('uKappaS', triToGL(c.kappaS))
      .vec3('uMask', triToGL(c.maskDepletion));
  }

  private runNegative(params: ResolvedParameters) {
    const gl = this.gl;
    const p = this.programs.negative!.use();
    bindTarget(gl, this.negative!);
    p.texture('uScene', 0, this.halScene!.texture);
    this.setNegativeUniforms(p, params);
    drawFullscreen(gl);
  }

  /**
   * §VIII. Returns the density texture the rest of the chain should read —
   * the inhibited one where the stage runs, the raw one where it does not.
   */
  private runInterlayer(params: ResolvedParameters): Target {
    const gl = this.gl;
    const il = params.interlayer;
    if (!il.enabled) return this.negative!;

    if (!this.ilBlur1) {
      this.ilBlur1 = createTarget(gl, this.width, this.height, gl.RGBA16F);
      this.ilBlur2 = createTarget(gl, this.width, this.height, gl.RGBA16F);
      this.ilScratch = createTarget(gl, this.width, this.height, gl.RGBA16F);
    }

    this.blur(this.negative!, this.ilScratch!, this.ilBlur1!, il.sigma1Px);
    this.blur(this.negative!, this.ilScratch!, this.ilBlur2!, il.sigma2Px);

    // The scratch buffer held the second blur's horizontal pass, which died
    // when the vertical pass consumed it, so the combine writes there rather
    // than asking for a fourth full-resolution float surface.
    const p = this.programs.interlayer!.use();
    bindTarget(gl, this.ilScratch!);
    p.texture('uScene', 0, this.halScene!.texture)
      .texture('uDensity', 1, this.negative!.texture)
      .texture('uBlur1', 2, this.ilBlur1!.texture)
      .texture('uBlur2', 3, this.ilBlur2!.texture)
      .mat3('uCoupling', matToGL(il.coupling))
      .float('uW1', il.w1)
      .float('uW2', il.w2)
      .float('uMu', il.mu);
    this.setNegativeUniforms(p, params);
    drawFullscreen(gl);
    return this.ilScratch!;
  }

  private runGrain(params: ResolvedParameters) {
    const gl = this.gl;
    const g = params.grain;
    const key: GrainCacheKey = {
      seed: g.seed,
      sigma1: g.sigma1Px,
      sigma2: g.sigma2Px,
      chi: g.chi,
      chol: g.cholesky.flat().join(','),
      width: this.width,
      height: this.height,
    };
    const serialized = JSON.stringify(key);
    if (this.grainKey === serialized) return;
    this.grainKey = serialized;

    // Three independent unit-variance white fields. Hash-based on pixel
    // coordinates, so re-running this mid-drag reproduces the identical field
    // and the grain does not crawl while a slider moves.
    const white = this.programs.noiseWhite!.use();
    bindTarget(gl, this.noiseA!);
    white.vec2('uSize', this.width, this.height).uint('uSeed', g.seed);
    drawFullscreen(gl);

    // The kernel is a mixture, so the same white field is blurred at both scales.
    this.blur(this.noiseA!, this.noiseB!, this.noiseNarrow!, g.sigma1Px);
    this.blur(this.noiseA!, this.noiseB!, this.noiseWide!, g.sigma2Px);

    // Blurring unit-variance white noise with a normalised Gaussian of width s
    // leaves variance 1/(4 pi s^2). Undo that so the field leaves this pass at
    // unit variance and sigmaRef can be a real Selwyn density downstream.
    const s1 = Math.max(g.sigma1Px, 0.35);
    const s2 = Math.max(g.sigma2Px, 0.5);
    const chi = g.chi;
    const variance =
      ((1 - chi) * (1 - chi)) / (4 * Math.PI * s1 * s1) +
      (chi * chi) / (4 * Math.PI * s2 * s2) +
      (2 * chi * (1 - chi)) / (2 * Math.PI * (s1 * s1 + s2 * s2));
    const normalise = 1 / Math.sqrt(Math.max(variance, 1e-12));

    const comb = this.programs.noiseCombine!.use();
    bindTarget(gl, this.grainField!);
    comb
      .texture('uNarrow', 0, this.noiseNarrow!.texture)
      .texture('uWide', 1, this.noiseWide!.texture)
      .float('uChi', chi)
      .float('uNormalise', normalise)
      .mat3('uCholesky', matToGL(g.cholesky));
    drawFullscreen(gl);
  }

  render(params: ResolvedParameters, view: ViewOptions) {
    const gl = this.gl;
    if (!this.sourceTex || !this.scene) return;

    // --- prepare -----------------------------------------------------------
    const prep = this.programs.prepare!.use();
    bindTarget(gl, this.scene);
    prep
      .texture('uSource', 0, this.sourceTex)
      .mat3('uInputMatrix', matToGL(params.inputMatrix))
      .float('uExposureGain', params.exposureGain)
      .int('uSourceIsEncoded', this.sourceEncoded ? 1 : 0)
      .int('uFlipY', this.sourceFlipY ? 1 : 0);
    // The camera develop, uniform for uniform with chain.ts's host mirror.
    // Identity parameters skip the stage entirely, same as the host path.
    const cam = params.camera;
    prep
      .int('uDevelopOn', developIsIdentity(cam) ? 0 : 1)
      .float('uContrast', cam.contrast)
      .float('uHighlights', cam.highlights)
      .float('uShadows', cam.shadows)
      .float('uWhites', cam.whites)
      .float('uBlacks', cam.blacks)
      .float('uSaturation', cam.saturation);
    drawFullscreen(gl);

    // Pre-exposure optics: taking-lens diffusion acts on the linear scene
    // before any of it is committed to the negative.
    this.runGlow(params);
    this.runHalation(params);
    this.runNegative(params);
    const density = this.runInterlayer(params);
    if (params.grain.enabled) this.runGrain(params);

    // --- the chain ---------------------------------------------------------
    const chain = this.programs.chain!.use();
    bindTarget(gl, this.processed);
    const c = params.curve;
    const p = params.printCurve;
    // The upload key is (stock, illuminant) — the same composite the app
    // passes into setPrintLut.
    const lutKey = params.printLut ? `${params.printLut.id}:${params.printLut.illuminant}` : '';
    const lutOn =
      params.printEngine === 'lut' &&
      params.printLut !== null &&
      this.printLutTex !== null &&
      lutKey !== '' &&
      this.printLutId === lutKey;
    chain
      .texture('uScene', 0, this.halScene!.texture)
      .texture('uNegative', 4, density.texture)
      .texture('uGrainField', 1, (this.grainField ?? this.halScene!).texture)
      .vec3('uDMin', triToGL(c.dMin))
      .vec3('uDeltaD', triToGL(c.deltaD))
      .int('uReversal', c.gamma[1] < 0 ? 1 : 0)
      .int('uGrainOn', params.grain.enabled ? 1 : 0)
      .float('uGrainAmount', params.grain.amount)
      .float('uSigmaRef', params.grain.sigmaRef)
      .float('uNu1', params.grain.nu[0])
      .float('uNu2', params.grain.nu[1])
      .float('uNuPeak', params.grain.nuPeak)
      .float('uResponseGamma', params.grain.responseGamma)
      .int('uSubtractive', 1)
      .vec3('uSubCmy', triToGL([params.subtractive.cyan, params.subtractive.magenta, params.subtractive.yellow]))
      .float('uSubDensity', params.subtractive.density)
      .int('uSubMode', params.subtractive.densityMode === 'multiply' ? 1 : 0)
      .int('uBypass', params.bypass ? 1 : 0)
      .mat3('uCrosstalk', matToGL(params.crosstalk))
      .vec3('uPrintOffset', triToGL(params.printExposureOffset))
      .int('uLutOn', lutOn ? 1 : 0);
    if (lutOn) {
      chain
        .texture3d('uPrintLut', 5, this.printLutTex!)
        .vec3('uLutAnchor', triToGL(params.printLut!.anchor))
        .mat3('uSRGBToAP1', matToGL(M_SRGB_TO_AP1));
    } else {
      chain.texture3d('uPrintLut', 5, this.printLutDummy!);
    }
    chain
      .vec3('uPDMin', triToGL(p.dMin))
      .vec3('uPDeltaD', triToGL(p.deltaD))
      .vec3('uPGamma', triToGL(p.gamma))
      .vec3('uPKappaT', triToGL(p.kappaT))
      .vec3('uPKappaS', triToGL(p.kappaS))
      .float('uSilver', params.silverRetention)
      .float('uSilverRange', 0.9)
      .vec3('uNeutralAxis', triToGL(params.neutralAxis))
      .mat3('uOutMatrix', matToGL(params.outputMatrix))
      .float('uSurround', params.surroundExponent)
      .int('uViewMode', VIEW_MODE_CODE[view.mode])
      .int('uClipWarn', view.clipWarning ? 1 : 0);
    drawFullscreen(gl);

    // --- to the canvas -----------------------------------------------------
    // Resizing a canvas clears it and detaches the compositor's texture, and
    // the spec clears it *even when the size has not changed*. Assigning both
    // dimensions on every render — every slider tick — used to blank the
    // canvas for the frames between the clear and the next present, which on
    // Windows/ANGLE reads as a white flash for a few hundred milliseconds.
    // Only touch the size when it actually differs; preserveDrawingBuffer
    // then keeps the last frame on screen until the new composite lands.
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    const comp = this.programs.composite!.use();
    bindTarget(gl, null, [this.width, this.height]);
    comp
      .texture('uProcessed', 0, this.processed!.texture)
      .texture('uScene', 1, this.scene.texture)
      .mat3('uOutMatrix', matToGL(params.outputMatrix))
      .float('uSplit', view.split)
      .float('uAspectPx', view.split > 0 ? 1 / this.width : -1);
    drawFullscreen(gl);
  }

  /** Reads the processed surface back for export or for the histogram. */
  readPixels(): ImageData {
    const gl = this.gl;
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.processed!.fbo);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL reads bottom-up; flip into image order.
    const flipped = new Uint8ClampedArray(data.length);
    const stride = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      flipped.set(data.subarray((this.height - 1 - y) * stride, (this.height - y) * stride), y * stride);
    }
    return new ImageData(flipped, this.width, this.height);
  }

  /** Re-renders at a higher working resolution for export, then restores. */
  renderAtResolution(params: ResolvedParameters, view: ViewOptions, maxWidth: number) {
    const previous: [number, number] = [this.width, this.height];
    const scale = Math.min(1, maxWidth / this.sourceW);
    const w = Math.max(1, Math.round(this.sourceW * scale));
    const h = Math.max(1, Math.round(this.sourceH * scale));
    this.allocate(w, h);
    this.render(params, { ...view, split: 0 });
    const data = this.readPixels();
    this.allocate(previous[0], previous[1]);
    return data;
  }

  dispose() {
    const gl = this.gl;
    this.releaseTargets();
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);
    if (this.printLutTex) gl.deleteTexture(this.printLutTex);
    if (this.printLutDummy) gl.deleteTexture(this.printLutDummy);
    for (const p of Object.values(this.programs)) p.dispose();
  }
}

/** IEEE 754 binary16, round-to-nearest-even. LUT values live in [0, 1]. */
function floatToHalf(v: number): number {
  const f = new Float32Array(1);
  const i = new Uint32Array(f.buffer);
  f[0] = v;
  const x = i[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const man = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00; // infinity / NaN
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    // Subnormal or zero: the LUT's values never get near this, but stay exact.
    if (e < -10) return sign;
    return sign | (((man | 0x800000) >>> (1 - e)) & 0x3ff);
  }
  return sign | (e << 10) | (man >>> 13);
}
