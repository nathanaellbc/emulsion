/**
 * The render graph (§XVI).
 *
 *   source -> prepare -> [defocus] -> [glow] -> [halation] -> negative -> [interlayer] -> chain -> canvas
 *                            |                         |                          |
 *                  depth -> CoC -> gather      source term -> pyramid      D, and two blurs of it
 *                            |                         |                          |
 *                         combine                  recombine                   combine
 *
 * Every intermediate is float: the chain works in density, and density is not
 * an 8-bit quantity. The 8-bit surfaces are the unit-variance noise fields
 * (the white field and the final grain field), where quantising to 256 steps
 * contributes about 0.0006 density of error — three orders below anything
 * visible. The blurred noise intermediates, whose variance is far below one,
 * are float.
 */

import { AP1_LUMINANCE, M_AP1_TO_SRGB, M_SRGB_TO_AP1 } from '../core/colorspace';
import { developIsIdentity } from '../core/develop';
import type { CubeLut } from '../core/cube';
import type { ResolvedParameters, SourceSpace } from '../core/resolve';
import { floatToHalf } from '../core/half';
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
import { PYRAMID_LEVELS, LEVEL_SIGMA, RING_RADIUS_UM, levelSigmas, pyramidWeightArray } from './halationFit';
import { FRAG_CHAIN, FRAG_COMPOSITE } from './shaders/chain';
import {
  DOF_MAX_EDGE,
  DOF_TILE,
  FRAG_DOF_COMBINE,
  FRAG_DOF_DILATE,
  FRAG_DOF_FAR,
  FRAG_DOF_NEAR,
  FRAG_DOF_PREP,
  FRAG_DOF_TILE,
} from './shaders/defocus';
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

export type ViewMode = 'print' | 'negative' | 'printDensity' | 'halationSource' | 'focus';

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
  // The focus view is the print, with the zone of acceptable sharpness laid
  // over it in the composite.
  focus: 0,
};

/**
 * A depth map for the defocus stage: normalised disparity, in the same row
 * order as the source it was estimated from.
 */
export interface DepthTexture {
  width: number;
  height: number;
  data: Float32Array;
}

/** Working resolution cap. Above this the passes cost more than they show. */
export const PREVIEW_MAX_WIDTH = 2048;
export const EXPORT_MAX_WIDTH = 4096;

interface GrainCacheKey {
  seed: number;
  offsetX: number;
  offsetY: number;
  sigma1: number;
  sigma2: number;
  chi: number;
  chol: string;
  width: number;
  height: number;
}

/** A tiled export abandoned between tiles: the settings it was for have changed. */
export class ExportCancelledError extends Error {
  constructor() {
    super('export superseded');
    this.name = 'ExportCancelledError';
  }
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly programs: Record<string, Program>;

  private sourceTex: WebGLTexture | null = null;
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

  /** The depth map, and the source it belongs to (see setDepth). */
  private depthTex: WebGLTexture | null = null;
  /** The depth map's disparity range: bounds the widest disc the photograph can throw. */
  private depthRange: [number, number] = [0, 1];

  /**
   * Where the current render sits in the whole picture, during a tiled export:
   * the tile's lower-left pixel (bottom-up, as GL counts) and the picture's
   * full size. Null for an ordinary render, which is the whole picture.
   */
  private tile: { x: number; y: number; fullW: number; fullH: number } | null = null;
  /**
   * The defocus stage's surfaces, allocated on first use: the gather grid
   * (with mips, for the prefiltered taps), its far and near fields, the
   * foreground reach per tile before and after dilation, and the lens's
   * full-resolution output.
   */
  private dofHalf: Target | null = null;
  private dofFar: Target | null = null;
  private dofNear: Target | null = null;
  private dofTiles: Target | null = null;
  private dofReach: Target | null = null;
  private lensOut: Target | null = null;

  /** The measured print stock's table, and the stock it was uploaded for. */
  private printLutTex: WebGLTexture | null = null;
  private printLutId: string | null = null;
  /** Node count per axis and input domain of the uploaded table. */
  private printLutSize = 1;
  private printLutDomain: [number, number] = [0, 1];
  /** A one-node table for the frames before a LUT arrives: an active
   * sampler3D uniform with a 2D texture (or nothing) on its unit makes the
   * whole draw invalid, so the chain always has *something* legal to read. */
  private printLutDummy: WebGLTexture | null = null;

  /**
   * The encoding the canvas — and so every read-back — holds. The chain's
   * output matrix produces Display P3, which is only right if the drawing
   * buffer is tagged P3; a default (sRGB) canvas shows P3 numbers as sRGB
   * ones and over-saturates everything. Where the browser can tag the buffer
   * P3 it is; where it cannot, the chain outputs sRGB instead.
   */
  readonly outputColorSpace: 'display-p3' | 'srgb';

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = createContext(canvas);
    const gl = this.gl;
    const tagged = gl as WebGL2RenderingContext & { drawingBufferColorSpace?: PredefinedColorSpace };
    if ('drawingBufferColorSpace' in tagged) {
      try {
        tagged.drawingBufferColorSpace = 'display-p3';
      } catch {
        // An unsupported value leaves the buffer sRGB, which is handled below.
      }
    }
    this.outputColorSpace = tagged.drawingBufferColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
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
      dofPrep: new Program(gl, FRAG_DOF_PREP, 'defocus grid'),
      dofTile: new Program(gl, FRAG_DOF_TILE, 'defocus tiles'),
      dofDilate: new Program(gl, FRAG_DOF_DILATE, 'defocus reach'),
      dofFar: new Program(gl, FRAG_DOF_FAR, 'defocus far field'),
      dofNear: new Program(gl, FRAG_DOF_NEAR, 'defocus near field'),
      dofCombine: new Program(gl, FRAG_DOF_COMBINE, 'defocus combine'),
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
   * True once the GL context has been lost. A lost context renders black and
   * every draw silently no-ops — the export path can allocate more memory than
   * a phone GPU will give (a full-resolution render is dozens of float
   * surfaces), and without this check that failure reads as an unexplained
   * black screen rather than a message.
   */
  get contextLost() {
    return this.gl.isContextLost();
  }



  /** The whole picture's size in render pixels: the tile's picture while tiling. */
  private fullSize(): [number, number] {
    return this.tile ? [this.tile.fullW, this.tile.fullH] : [this.width, this.height];
  }

  /**
   * This render's rectangle in the picture as the shaders take it: display x,
   * display y from the top, width and height, all as fractions of the picture.
   */
  private tileRect(): [number, number, number, number] {
    if (!this.tile) return [0, 0, 1, 1];
    const { x, y, fullW, fullH } = this.tile;
    const top = fullH - (y + this.height);
    return [x / fullW, top / fullH, this.width / fullW, this.height / fullH];
  }

  /**
   * The defocus gather grid's scale: a power of two, so every tile of a tiled
   * export lays its grid on the same lattice the whole-frame render would,
   * and never finer than half resolution or coarser than DOF_MAX_EDGE on the
   * long side of the picture.
   */
  private dofGridScale(): number {
    const [fw, fh] = this.fullSize();
    const k = Math.max(1, Math.ceil(Math.log2(Math.max(fw, fh) / DOF_MAX_EDGE)));
    return Math.pow(2, -k);
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
    this.printLutSize = lut.size;
    this.printLutDomain = [lut.domainMin, lut.domainMax];
  }

  /**
   * Uploads a decoded image and sizes the graph to it. Returns the encoding
   * the texture actually holds when the upload chose it, or null when the
   * decoder's own declaration stands.
   *
   * A display-referred file may carry a wider profile than sRGB — every iPhone
   * photograph is Display P3 — and the browser's default upload converts it to
   * sRGB, clipping exactly the saturated colours a film stock has the most to
   * say about. Where the context can unpack into Display P3, it does: P3
   * contains sRGB, so an sRGB file loses nothing and a P3 file keeps its gamut.
   */
  setSource(image: SourceImage, maxWidth = PREVIEW_MAX_WIDTH): SourceSpace | null {
    const gl = this.gl;
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);

    const tex = gl.createTexture();
    if (!tex) throw new Error('could not allocate the source texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    let uploadedSpace: SourceSpace | null = null;

    if (image.float) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, image.width, image.height, 0,
        gl.RGBA, gl.FLOAT, image.float,
      );
    } else if (image.bitmap) {
      const p3 = gl as WebGL2RenderingContext & { unpackColorSpace?: PredefinedColorSpace };
      if ('unpackColorSpace' in p3) {
        p3.unpackColorSpace = 'display-p3';
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image.bitmap);
        p3.unpackColorSpace = 'srgb';
        uploadedSpace = 'displayP3';
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image.bitmap);
      }
    } else {
      throw new Error('source image carries neither pixels nor a bitmap');
    }
    // A mip chain, so any render smaller than the source — the preview, an
    // export below the file's own size — is a filtered downscale rather than
    // a bilinear point sample that skips most of the pixels between its taps
    // and aliases every fine texture in the photograph. At the source's own
    // size the level of detail is zero and the full-resolution pixels are
    // read exactly.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.sourceTex = tex;
    this.setDepth(null);
    this.sourceEncoded = image.encoded;
    // A DOM image or bitmap arrives with its origin top-left; float data we
    // decoded ourselves is already in texture order.
    this.sourceFlipY = !image.float;

    const scale = Math.min(1, maxWidth / image.width);
    this.allocate(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    return uploadedSpace;
  }

  /**
   * Uploads (or, with null, drops) the depth map that drives defocus. The map
   * must be in the current source's row order — `depth/estimate.ts` builds it
   * so — and it is sampled through the same flip the prepare pass applies to
   * the source, so the two cannot disagree about which way is up. A new
   * source drops the map: it described a different photograph.
   */
  setDepth(depth: DepthTexture | null) {
    const gl = this.gl;
    if (this.depthTex) {
      gl.deleteTexture(this.depthTex);
      this.depthTex = null;
    }
    if (!depth) return;
    const tex = gl.createTexture();
    if (!tex) throw new Error('could not allocate the depth texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Half floats: 11 bits across a 0–1.5 disparity range is a thousandth of
    // the scene's depth, finer than the network resolves.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, depth.width, depth.height, 0, gl.RED, gl.FLOAT, depth.data);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < depth.data.length; i++) {
      const d = depth.data[i]!;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    this.depthRange = [Math.min(lo, hi), Math.max(lo, hi)];
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.depthTex = tex;
  }

  get hasDepth() {
    return this.depthTex !== null;
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

    // The white field and the final unit-variance grain field are 8-bit: at
    // unit variance one code step is 0.031 sigma. The blurred intermediates
    // are not — a Gaussian of width s leaves a standard deviation of
    // 1/(2 sqrt(pi) s), so at s = 3 px one 8-bit step would be a third of a
    // sigma and the clustered grain would posterise. They are float.
    this.noiseA = createTarget(gl, width, height, gl.RGBA8);
    this.noiseB = createTarget(gl, width, height, gl.RGBA16F);
    this.noiseNarrow = createTarget(gl, width, height, gl.RGBA16F);
    this.noiseWide = createTarget(gl, width, height, gl.RGBA16F);
    this.grainField = createTarget(gl, width, height, gl.RGBA8);
    this.grainKey = null;
  }

  private releaseTargets() {
    const gl = this.gl;
    const all = [
      this.scene, this.halScene, this.negative, this.processed,
      this.glowTight, this.glowBroad, this.glowBroadTemp, this.glowTemp, this.glowOut,
      this.ilBlur1, this.ilBlur2, this.ilScratch,
      this.dofHalf, this.dofFar, this.dofNear, this.dofTiles, this.dofReach, this.lensOut,
      this.noiseA, this.noiseB, this.noiseNarrow, this.noiseWide, this.grainField,
      ...this.halSrc, ...this.halTemps, ...this.halLevels,
    ];
    for (const t of all) if (t) disposeTarget(gl, t);
    this.scene = this.halScene = this.negative = this.processed = null;
    this.glowTight = this.glowBroad = this.glowBroadTemp = this.glowTemp = this.glowOut = null;
    this.ilBlur1 = this.ilBlur2 = this.ilScratch = null;
    this.dofHalf = this.dofFar = this.dofNear = this.dofTiles = this.dofReach = this.lensOut = null;
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

  /** The CoC uniforms every defocus pass and the focus view share. */
  private setCocUniforms(p: Program, params: ResolvedParameters, unit: number) {
    const d = params.defocus;
    p.texture('uDepth', unit, this.depthTex!)
      .int('uDepthFlip', this.sourceFlipY ? 1 : 0)
      .float('uFocusDisparity', d.focusDisparity)
      .float('uCocScale', d.cocScalePx)
      .float('uMaxCoc', d.maxCocPx);
    const [tx, ty, tw, th] = this.tileRect();
    p.vec4('uTile', tx, ty, tw, th);
  }

  private setApertureUniforms(p: Program, params: ResolvedParameters) {
    const d = params.defocus;
    const [fw, fh] = this.fullSize();
    const diag = Math.hypot(fw, fh);
    const [tx, ty, tw, th] = this.tileRect();
    p.int('uBlades', d.blades)
      .float('uCurvature', d.bladeCurvature)
      .float('uCatEye', d.catEye)
      .vec2('uAspect', fw / diag, fh / diag)
      .vec4('uTile', tx, ty, tw, th);
  }

  /** A render target with a full mip chain, for prefiltered sparse sampling. */
  private createMipTarget(width: number, height: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('could not allocate the defocus grid');
    const levels = Math.floor(Math.log2(Math.max(width, height, 1))) + 1;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('could not allocate the defocus framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, texture, width, height, internalFormat: gl.RGBA16F };
  }

  /**
   * Synthetic defocus (§XIII; shaders/defocus.ts). Returns the target the
   * rest of the graph should read as the lens's image — the scene itself
   * where the stage is off or there is no depth map to drive it.
   */
  private runDefocus(params: ResolvedParameters): Target {
    const gl = this.gl;
    if (!params.defocus.enabled || !this.depthTex) return this.scene!;

    const gridScale = this.dofGridScale();
    const gw = Math.max(1, Math.round(this.width * gridScale));
    const gh = Math.max(1, Math.round(this.height * gridScale));
    const tw = Math.ceil(gw / DOF_TILE);
    const th = Math.ceil(gh / DOF_TILE);
    if (!this.dofHalf || this.dofHalf.width !== gw || this.dofHalf.height !== gh) {
      for (const t of [this.dofHalf, this.dofFar, this.dofNear, this.dofTiles, this.dofReach, this.lensOut]) {
        if (t) disposeTarget(gl, t);
      }
      this.dofHalf = this.createMipTarget(gw, gh);
      this.dofFar = createTarget(gl, gw, gh, gl.RGBA16F);
      this.dofNear = createTarget(gl, gw, gh, gl.RGBA16F);
      this.dofTiles = createTarget(gl, tw, th, gl.RGBA16F, gl.NEAREST);
      this.dofReach = createTarget(gl, tw, th, gl.RGBA16F, gl.NEAREST);
      this.lensOut = createTarget(gl, this.width, this.height, gl.RGBA16F);
    }
    // The actual grid-per-render ratio after rounding, which the CoC radius
    // in grid pixels must use.
    const scale = gw / this.width;

    const prep = this.programs.dofPrep!.use();
    bindTarget(gl, this.dofHalf);
    prep
      .texture('uScene', 0, this.scene!.texture)
      .float('uGridScale', scale)
      .int('uTaps', Math.min(8, Math.max(1, Math.round(0.5 / scale))));
    this.setCocUniforms(prep, params, 1);
    drawFullscreen(gl);
    gl.bindTexture(gl.TEXTURE_2D, this.dofHalf.texture);
    gl.generateMipmap(gl.TEXTURE_2D);

    const tile = this.programs.dofTile!.use();
    bindTarget(gl, this.dofTiles);
    tile.texture('uHalf', 0, this.dofHalf.texture);
    drawFullscreen(gl);

    // How many tiles the widest possible foreground disc can cross.
    const maxRadiusGrid = params.defocus.maxCocPx * 0.5 * scale;
    const dil = this.programs.dofDilate!.use();
    bindTarget(gl, this.dofReach);
    dil
      .texture('uTiles', 0, this.dofTiles!.texture)
      .int('uReach', Math.min(8, Math.ceil(maxRadiusGrid / DOF_TILE)));
    drawFullscreen(gl);

    const far = this.programs.dofFar!.use();
    bindTarget(gl, this.dofFar);
    far.texture('uHalf', 0, this.dofHalf.texture);
    this.setApertureUniforms(far, params);
    drawFullscreen(gl);

    const near = this.programs.dofNear!.use();
    bindTarget(gl, this.dofNear);
    near.texture('uHalf', 0, this.dofHalf.texture).texture('uTiles', 1, this.dofReach!.texture);
    this.setApertureUniforms(near, params);
    drawFullscreen(gl);

    const comb = this.programs.dofCombine!.use();
    bindTarget(gl, this.lensOut);
    comb
      .texture('uScene', 0, this.scene!.texture)
      .texture('uFar', 1, this.dofFar!.texture)
      .texture('uNear', 2, this.dofNear!.texture)
      .float('uGridScale', scale);
    this.setCocUniforms(comb, params, 3);
    drawFullscreen(gl);
    return this.lensOut!;
  }

  /**
   * Taking-lens diffusion (§XIII). Convolves the lens's image into a tight halo
   * and a broad veil, then recombines them energy-conserving before the film is
   * exposed. Runs on `scene` and leaves the result in `glowOut`, which the rest
   * of the graph reads in place of the raw scene; disabled, it is a straight
   * copy so the graph keeps its shape.
   */
  private runGlow(params: ResolvedParameters, scene: Target) {
    const gl = this.gl;
    const g = params.glow;
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
    // Level 0's source slot still holds the unblurred source term: its blur
    // went to halLevels[0], and only the coarser slots were overwritten.
    comb
      .texture('uSourceTerm', 1 + PYRAMID_LEVELS, this.halSrc[0]!.texture)
      .vec3('uLuminance', triToGL(AP1_LUMINANCE));
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
      offsetX: this.tile?.x ?? 0,
      offsetY: this.tile?.y ?? 0,
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
    white
      .vec2('uSize', this.width, this.height)
      .vec2('uPixelOffset', this.tile?.x ?? 0, this.tile?.y ?? 0)
      .uint('uSeed', g.seed);
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
    if (!this.sourceTex || !this.scene) return;
    this.renderGraph(params, view);
    this.present(params, view);
  }

  /** The whole graph, source to the processed print, into `processed`. */
  private renderGraph(params: ResolvedParameters, view: ViewOptions) {
    const gl = this.gl;
    if (!this.sourceTex || !this.scene) return;
    const [tx, ty, tw, th] = this.tileRect();

    // --- prepare -----------------------------------------------------------
    const prep = this.programs.prepare!.use();
    bindTarget(gl, this.scene);
    prep
      .texture('uSource', 0, this.sourceTex)
      .mat3('uInputMatrix', matToGL(params.inputMatrix))
      .float('uExposureGain', params.exposureGain)
      .int('uSourceIsEncoded', this.sourceEncoded ? 1 : 0)
      .int('uFlipY', this.sourceFlipY ? 1 : 0)
      .vec4('uTile', tx, ty, tw, th);
    // The camera develop, uniform for uniform with chain.ts's host mirror.
    // Identity parameters skip the stage entirely, same as the host path.
    const cam = params.camera;
    prep
      .int('uDevelopOn', developIsIdentity(cam) ? 0 : 1)
      .float('uPivot', cam.pivot)
      .float('uContrast', cam.contrast)
      .float('uHighlights', cam.highlights)
      .float('uShadows', cam.shadows)
      .float('uWhites', cam.whites)
      .float('uBlacks', cam.blacks)
      .float('uSaturation', cam.saturation);
    drawFullscreen(gl);

    // Pre-exposure optics: the lens forms the image (defocus), a diffusion
    // filter on it scatters that image (glow), and only then is any of it
    // committed to the negative.
    const lens = this.runDefocus(params);
    this.runGlow(params, lens);
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
      // A measured engine whose table is not on the GPU yet renders the model,
      // and the model needs its aim balance — the measured-engine offset holds
      // only the user's lights, which on the model prints a grey as paper white.
      .vec3(
        'uPrintOffset',
        triToGL(lutOn ? params.printExposureOffset : params.modelPrintExposureOffset),
      )
      .int('uLutOn', lutOn ? 1 : 0);
    if (lutOn) {
      chain
        .texture3d('uPrintLut', 5, this.printLutTex!)
        .float('uLutSize', this.printLutSize)
        .vec2('uLutDomain', this.printLutDomain[0], this.printLutDomain[1])
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
      .mat3('uOutMatrix', matToGL(this.outputMatrix(params)))
      .float('uSurround', params.surroundExponent)
      .int('uViewMode', VIEW_MODE_CODE[view.mode])
      .int('uClipWarn', view.clipWarning ? 1 : 0);
    drawFullscreen(gl);
  }

  /** The processed print (and the comparison, the focus view) onto the canvas. */
  private present(params: ResolvedParameters, view: ViewOptions) {
    const gl = this.gl;
    if (!this.scene) return;
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
      .mat3('uOutMatrix', matToGL(this.outputMatrix(params)))
      .float('uSplit', view.split)
      .float('uAspectPx', view.split > 0 ? 1 / this.width : -1);
    const focusView = view.mode === 'focus' && this.depthTex !== null;
    comp.int('uFocusView', focusView ? 1 : 0).float('uAcceptCoc', params.defocus.acceptableCocPx);
    if (focusView) this.setCocUniforms(comp, params, 2);
    drawFullscreen(gl);
  }

  /** Working space to whatever the canvas is tagged as. */
  private outputMatrix(params: ResolvedParameters) {
    return this.outputColorSpace === 'display-p3' ? params.outputMatrix : M_AP1_TO_SRGB;
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
    // Tagged with the encoding the pixels are in, so an export carries the
    // right profile rather than being read as sRGB.
    try {
      return new ImageData(flipped, this.width, this.height, { colorSpace: this.outputColorSpace });
    } catch {
      return new ImageData(flipped, this.width, this.height);
    }
  }

  /**
   * How far a pixel's value can depend on its neighbours, in render pixels,
   * for these parameters: the margin a tile must render beyond the pixels it
   * keeps so that every kept pixel sees everything it would in a whole-frame
   * render. The spatial stages are chained — the lens feeds the diffusion,
   * the diffusion the halation, the halation the negative and the interlayer
   * — so their reaches add; grain is its own branch.
   */
  exportApron(params: ResolvedParameters): number {
    let reach = 0;
    const d = params.defocus;
    if (d.enabled && this.depthTex) {
      // The widest disc this photograph actually throws, from its depth range,
      // not the cap: most pictures never reach it.
      const df = Math.max(d.focusDisparity, 0.02);
      const widest = Math.max(
        Math.abs(1 - this.depthRange[0] / df),
        Math.abs(1 - this.depthRange[1] / df),
      );
      const radius = Math.min(d.cocScalePx * widest, d.maxCocPx) * 0.5;
      // Plus the foreground's tile dilation (two 16-texel grid tiles) and the
      // combine's tent.
      reach += radius + (2 * 16 + 2) / this.dofGridScale();
    }
    const g = params.glow;
    if (g.enabled) reach += 3 * (g.sigma1Px + g.sigma2Px) + 2;
    const h = params.halation;
    if (h.enabled) {
      const pitchUm =
        (params.negative.halation.lengthRedUm * params.recipe.halation.radius) /
        Math.max(h.lengthPx[0], 1e-6);
      const weights = pyramidWeightArray(h.lengthPx, h.omega, RING_RADIUS_UM / Math.max(pitchUm, 1e-6));
      const sigmas = levelSigmas();
      let total = 0;
      for (let i = 0; i < weights.length; i++) total += Math.abs(weights[i]!);
      let widest = 0;
      for (let j = 0; j < PYRAMID_LEVELS; j++) {
        const w = Math.max(
          Math.abs(weights[j * 3]!),
          Math.abs(weights[j * 3 + 1]!),
          Math.abs(weights[j * 3 + 2]!),
        );
        // A level carrying under a thousandth of the halo cannot show.
        if (w > 1e-3 * total) widest = Math.max(widest, 3 * sigmas[j]! + Math.pow(2, j));
      }
      reach += widest;
    }
    const il = params.interlayer;
    if (il.enabled) reach += 3 * Math.max(il.sigma1Px, il.sigma2Px) + 2;
    const grain = params.grain.enabled ? 3 * Math.max(params.grain.sigma1Px, params.grain.sigma2Px) + 2 : 0;
    return Math.ceil(Math.max(reach, grain)) + 8;
  }

  /**
   * Renders the print at the picture's own `fullW` x `fullH` — its native
   * size, or any size below it — in tiles, handing each finished tile to
   * `draw` with its top-left position in the picture.
   *
   * The whole graph at full resolution is a dozen float surfaces per pixel,
   * over a gigabyte for a 12 MP photograph, which no phone gives a web page.
   * A tile is the same graph over a small rectangle plus an apron wide enough
   * for every spatial stage (exportApron); only the tile's core is kept, so
   * each kept pixel is computed from exactly the neighbourhood it would have
   * had in one pass over the whole frame. Tiles start on a 128-pixel lattice,
   * so the halation pyramid's coarsest level, the glow's half-resolution
   * veil and the defocus grid sit in the same phase in every tile, and grain
   * is hashed from the pixel's place in the picture: the seams are not
   * softened, there are none. Past the picture's edges the apron carries on
   * over the source's own edge pixels, extended — the same border in every
   * tiling, so a single tile and many agree to the rounding of a half float.
   *
   * Yields to the event loop between tiles, so the page stays alive and the
   * progress can be drawn.
   */
  async renderTiled(
    params: ResolvedParameters,
    fullW: number,
    fullH: number,
    draw: (tile: ImageData, x: number, y: number) => void,
    onProgress?: (done: number, total: number) => void,
    isCancelled?: () => boolean,
  ): Promise<void> {
    const previous: [number, number] = [this.width, this.height];
    const LATTICE = 128;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
    const budget = coarse ? 192 * 1024 * 1024 : 640 * 1024 * 1024;
    const bytesPerPixel = 108 + (params.defocus.enabled ? 15 : 0);
    // A test hook (scripts/verify-tiles.mjs): force small tiles on any device,
    // so a many-tile render can be compared against a whole-frame one.
    const forced = (globalThis as { __emulsionTileSide?: number }).__emulsionTileSide;
    const side = Math.min(
      this.maxTextureSize,
      forced ?? Math.floor(Math.sqrt(budget / bytesPerPixel)),
    );
    const apron = this.exportApron(params);
    // The kept core: what the budget leaves after the apron, on the lattice,
    // never so small that the apron is all the work.
    let core = Math.floor((side - 2 * apron) / LATTICE) * LATTICE;
    core = Math.max(core, 2 * LATTICE);
    // One tile when the whole picture, apron and all, fits.
    const padded = (n: number) => Math.ceil((n + 2 * apron) / LATTICE) * LATTICE + LATTICE;
    if (padded(fullW) <= side && padded(fullH) <= side) core = Math.max(fullW, fullH);

    const cols = Math.ceil(fullW / core);
    const rows = Math.ceil(fullH / core);
    const total = cols * rows;
    // Read back by the verification scripts: how the last export was cut.
    (globalThis as { __emulsionLastTiling?: object }).__emulsionLastTiling = { cols, rows, core, apron, side };
    const view: ViewOptions = { mode: 'print', split: 0, clipWarning: false };
    let done = 0;
    try {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // The core, bottom-up as GL counts rows.
          const cx0 = c * core;
          const cy0 = r * core;
          const cx1 = Math.min(fullW, cx0 + core);
          const cy1 = Math.min(fullH, cy0 + core);
          // The rendered rectangle: the core plus its apron, snapped outward
          // to the lattice — including past the picture's edges, where the
          // source is extended by its own edge pixels. Every tile is then a
          // whole number of lattice cells, so every pyramid level, mip level
          // and grid cell maps onto the picture exactly, in every tile alike,
          // and one tile or a hundred give the same print.
          const rx0 = Math.floor((cx0 - apron) / LATTICE) * LATTICE;
          const ry0 = Math.floor((cy0 - apron) / LATTICE) * LATTICE;
          const rx1 = Math.ceil((cx1 + apron) / LATTICE) * LATTICE;
          const ry1 = Math.ceil((cy1 + apron) / LATTICE) * LATTICE;

          this.tile = { x: rx0, y: ry0, fullW, fullH };
          this.allocate(rx1 - rx0, ry1 - ry0);
          this.renderGraph(params, view);
          if (this.contextLost) throw new Error('the graphics context was lost while rendering the export');

          const cw = cx1 - cx0;
          const ch = cy1 - cy0;
          const data = new Uint8ClampedArray(cw * ch * 4);
          const gl = this.gl;
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.processed!.fbo);
          gl.readPixels(cx0 - rx0, cy0 - ry0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, data);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          // GL rows run bottom-up; an image's run top-down.
          const flipped = new Uint8ClampedArray(data.length);
          const stride = cw * 4;
          for (let y = 0; y < ch; y++) {
            flipped.set(data.subarray((ch - 1 - y) * stride, (ch - y) * stride), y * stride);
          }
          let image: ImageData;
          try {
            image = new ImageData(flipped, cw, ch, { colorSpace: this.outputColorSpace });
          } catch {
            image = new ImageData(flipped, cw, ch);
          }
          draw(image, cx0, fullH - cy1);
          onProgress?.(++done, total);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (isCancelled?.()) throw new ExportCancelledError();
        }
      }
    } finally {
      this.tile = null;
      this.grainKey = null;
      this.allocate(previous[0], previous[1]);
    }
  }

  dispose() {
    const gl = this.gl;
    this.releaseTargets();
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);
    if (this.depthTex) gl.deleteTexture(this.depthTex);
    if (this.printLutTex) gl.deleteTexture(this.printLutTex);
    if (this.printLutDummy) gl.deleteTexture(this.printLutDummy);
    for (const p of Object.values(this.programs)) p.dispose();
  }
}

