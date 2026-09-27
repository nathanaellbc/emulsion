/**
 * The page's side of depth estimation: build the picture the network sees,
 * hand it to the worker, and turn a focus tap into a disparity.
 *
 * Row order is the one subtle thing here. The depth map is built in the
 * *source texture's* row order — a bitmap's rows top-down, a RAW decode's
 * float rows as LibRaw delivered them — so the renderer samples it through
 * exactly the flip the prepare pass applies to the source, and the two can
 * never disagree about which way is up.
 */

import { M_AP0_TO_AP1, M_AP1_TO_SRGB, M_P3_TO_AP1, M_SRGB_TO_AP1, srgbOetf } from '../core/colorspace';
import type { SourceSpace } from '../core/resolve';
import { matMul, type Matrix3 } from '../core/triple';
import type { DecodedSource } from '../io/decode';
import type { DepthBackend, DepthProfile } from './model';
import type { DepthPhase, DepthRequest, DepthResponse } from './protocol';
import { sampleDisparity } from './refine';

/**
 * The guide's long edge. The network sees 518 px on the short side whatever
 * it is given; the guide is the resolution the refinement recovers edges at,
 * and the scale the renderer samples. 1536 keeps a 2048 preview's edges
 * within a pixel and the worker's refinement under a quarter-second.
 */
export const GUIDE_MAX_EDGE = 1536;

export interface DepthMap {
  width: number;
  height: number;
  /** Normalised disparity, source row order: 0 at infinity, 1 at the near anchor. */
  data: Float32Array;
  /** True when rows run bottom-up on screen (a float RAW decode, uploaded unflipped). */
  rowsBottomUp: boolean;
  backend: DepthBackend;
  variant: 'fp16' | 'int8';
  inferMs: number;
}

export interface DepthProgress {
  phase: DepthPhase;
  loaded: number;
  total: number;
}

export class DepthNotCachedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepthNotCachedError';
  }
}

export class DepthCancelledError extends Error {
  constructor() {
    super('superseded by a newer request');
    this.name = 'DepthCancelledError';
  }
}

function toSrgbMatrix(space: SourceSpace): Matrix3 {
  switch (space) {
    case 'acesAP0':
      return matMul(M_AP1_TO_SRGB, M_AP0_TO_AP1);
    case 'displayP3':
      return matMul(M_AP1_TO_SRGB, M_P3_TO_AP1);
    case 'linearAP1':
      return M_AP1_TO_SRGB;
    case 'srgb':
      return matMul(M_AP1_TO_SRGB, M_SRGB_TO_AP1);
  }
}

/**
 * The picture the network sees: display-referred sRGB, as the photographs it
 * was trained on are. A bitmap is drawn down as it is; a scene-linear RAW is
 * box-filtered, carried into sRGB, anchored so its log-average sits at scene
 * grey, and encoded — a plain "camera JPEG" of it, no film involved.
 */
export function buildGuide(
  source: DecodedSource,
  maxEdge: number = GUIDE_MAX_EDGE,
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const { image } = source;
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  if (image.bitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D canvas to prepare the depth guide on');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.bitmap as CanvasImageSource, 0, 0, width, height);
    return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
  }

  if (!image.float) throw new Error('the source carries no pixels to estimate depth from');
  const src = image.float;
  const m = toSrgbMatrix(source.space);
  const lin = new Float32Array(width * height * 3);
  let logSum = 0;
  let logCount = 0;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      const o = (y * width + x) * 3;
      const lr = m[0][0] * r + m[0][1] * g + m[0][2] * b;
      const lg = m[1][0] * r + m[1][1] * g + m[1][2] * b;
      const lb = m[2][0] * r + m[2][1] * g + m[2][2] * b;
      lin[o] = lr;
      lin[o + 1] = lg;
      lin[o + 2] = lb;
      const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      if (lum > 1e-5) {
        logSum += Math.log(lum);
        logCount++;
      }
    }
  }
  const gain = logCount ? 0.18 / Math.exp(logSum / logCount) : 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = srgbOetf(Math.min(Math.max(lin[i * 3]! * gain, 0), 1)) * 255 + 0.5;
    rgba[i * 4 + 1] = srgbOetf(Math.min(Math.max(lin[i * 3 + 1]! * gain, 0), 1)) * 255 + 0.5;
    rgba[i * 4 + 2] = srgbOetf(Math.min(Math.max(lin[i * 3 + 2]! * gain, 0), 1)) * 255 + 0.5;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, width, height };
}

/**
 * Normalised disparity under a point given in display coordinates ((0, 0)
 * top-left), read from the map's own row order.
 */
export function disparityAt(map: DepthMap, x: number, y: number): number {
  return sampleDisparity(map.data, map.width, map.height, x, map.rowsBottomUp ? 1 - y : y);
}

/**
 * The depth worker, created on first use for the backend the device profile
 * names. On a low-memory profile (a phone) it is torn down after every
 * estimate: WebAssembly memory never shrinks and a WebGPU device keeps its
 * buffers while it lives, so a worker kept warm would hold a few hundred
 * megabytes of the tab's budget for the rest of the session. The price is
 * a second or two to rebuild the session from the cache next time.
 */
export class DepthEstimator {
  private worker: Worker | null = null;
  private workerBackend: DepthBackend | null = null;
  private nextId = 1;
  private pending: {
    id: number;
    resolve: (m: DepthMap) => void;
    reject: (e: Error) => void;
    onProgress?: (p: DepthProgress) => void;
    rowsBottomUp: boolean;
    lowMemory: boolean;
  } | null = null;

  private ensureWorker(backend: DepthBackend): Worker {
    if (this.worker && this.workerBackend === backend) return this.worker;
    this.terminate();
    // Two literal URLs, so the bundler sees both entries; a device only ever
    // loads the one its profile names.
    const w =
      backend === 'webgpu'
        ? new Worker(new URL('./depth-gpu.worker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('./depth-cpu.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DepthResponse>) => this.receive(e.data);
    w.onerror = (e) => {
      const p = this.pending;
      this.pending = null;
      this.terminate();
      p?.reject(new Error(e.message || 'the depth worker failed to start'));
    };
    this.worker = w;
    this.workerBackend = backend;
    return w;
  }

  private terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.workerBackend = null;
  }

  private receive(msg: DepthResponse) {
    const p = this.pending;
    if (!p || msg.id !== p.id) return;
    if (msg.type === 'progress') {
      p.onProgress?.({ phase: msg.phase, loaded: msg.loaded, total: msg.total });
      return;
    }
    this.pending = null;
    if (p.lowMemory) this.terminate();
    if (msg.type === 'error') {
      p.reject(msg.code === 'not-cached' ? new DepthNotCachedError(msg.message) : new Error(msg.message));
      return;
    }
    p.resolve({
      width: msg.width,
      height: msg.height,
      data: msg.depth,
      rowsBottomUp: p.rowsBottomUp,
      backend: msg.backend,
      variant: msg.variant,
      inferMs: msg.inferMs,
    });
  }

  /**
   * Estimates the depth of `source`. A newer call supersedes an older one,
   * whose promise rejects with DepthCancelledError. With `allowDownload`
   * false, a device without the weights gets DepthNotCachedError instead of a
   * surprise download.
   */
  estimate(
    source: DecodedSource,
    opts: { allowDownload: boolean; profile: DepthProfile; onProgress?: (p: DepthProgress) => void },
  ): Promise<DepthMap> {
    const { profile } = opts;
    if (this.pending) {
      this.pending.reject(new DepthCancelledError());
      this.pending = null;
      // A superseded job would otherwise run to completion first, holding
      // its memory while the new one waits behind it.
      this.terminate();
    }
    const worker = this.ensureWorker(profile.backend);
    const guide = buildGuide(source, profile.guideMaxEdge);
    const id = this.nextId++;
    return new Promise<DepthMap>((resolve, reject) => {
      this.pending = {
        id,
        resolve,
        reject,
        onProgress: opts.onProgress,
        // The renderer flips a bitmap's rows and leaves a float decode's
        // alone (renderer.ts, setSource), so a float decode's first row is
        // the bottom of the picture on screen.
        rowsBottomUp: !!source.image.float,
        lowMemory: profile.lowMemory,
      };
      const req: DepthRequest = {
        type: 'estimate',
        id,
        rgba: guide.rgba,
        width: guide.width,
        height: guide.height,
        allowDownload: opts.allowDownload,
        backend: profile.backend,
        inputSize: profile.inputSize,
        lowMemory: profile.lowMemory,
      };
      worker.postMessage(req, [guide.rgba.buffer]);
    });
  }

  dispose() {
    this.pending?.reject(new DepthCancelledError());
    this.pending = null;
    this.terminate();
  }
}
