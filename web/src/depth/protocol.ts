import type { DepthBackend } from './model';

export type DepthPhase = 'runtime' | 'model' | 'compile' | 'infer' | 'refine';

export type DepthRequest = {
  type: 'estimate';
  id: number;
  /** The guide picture: sRGB RGBA8, in the source texture's row order. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** False: fail with 'not-cached' rather than start a download. */
  allowDownload: boolean;
};

export type DepthResponse =
  | { type: 'progress'; id: number; phase: DepthPhase; loaded: number; total: number }
  | {
      type: 'result';
      id: number;
      width: number;
      height: number;
      /** Normalised disparity: 0 at the far anchor (infinity), 1 at the near one. */
      depth: Float32Array;
      backend: DepthBackend;
      variant: 'fp16' | 'int8';
      inferMs: number;
    }
  | { type: 'error'; id: number; code: 'not-cached' | 'failed'; message: string };
