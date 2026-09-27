/// <reference lib="webworker" />
/**
 * Depth estimation, off the main thread: the ONNX runtime, the network, and
 * the joint bilateral refinement all run here, so the bench stays responsive
 * while a phone spends seconds on the CPU path.
 *
 * Two thin entries share this body, one per ONNX Runtime build:
 * `depth-gpu.worker.ts` (WebGPU, with the CPU kernels for its fallback) and
 * `depth-cpu.worker.ts` (plain WebAssembly, half the binary). A device only
 * ever downloads and compiles the one it runs.
 *
 * The runtime's WebAssembly binary is fetched through the same persistent
 * cache as the weights and handed over as bytes: left to fetch itself, it
 * would land in the service worker's versioned cache and be downloaded again
 * after every app update.
 */

import type * as Ort from 'onnxruntime-web';
import { DEPTH_CACHE, VARIANTS, fetchCached, variantUrl, type DepthBackend } from './model';
import {
  jointBilateralUpsample,
  modelInputSize,
  normaliseDisparity,
  resampleRGB,
  toModelTensor,
} from './refine';
import type { DepthRequest, DepthResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

class NotCachedError extends Error {
  constructor() {
    super('The depth model is not on this device yet.');
    this.name = 'NotCachedError';
  }
}

/** Installs the worker's message handler for one ONNX Runtime build. */
export function serveDepth(ort: typeof Ort, ortWasmUrl: string, runtimeBytes: number) {
let runtimeReady: Promise<void> | null = null;
const sessions = new Map<DepthBackend, Promise<Ort.InferenceSession>>();

function post(msg: DepthResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function loadRuntime(id: number): Promise<void> {
  runtimeReady ??= (async () => {
    const wasm = await fetchCached(new URL(ortWasmUrl, self.location.href).href, runtimeBytes, (loaded, total) =>
      post({ type: 'progress', id, phase: 'runtime', loaded, total }),
    );
    ort.env.wasm.wasmBinary = wasm;
    // Threads need SharedArrayBuffer, which needs cross-origin isolation;
    // without it the runtime would try and fail, so ask for one.
    ort.env.wasm.numThreads = self.crossOriginIsolated
      ? Math.min(4, Math.max(1, navigator.hardwareConcurrency || 1))
      : 1;
    ort.env.wasm.proxy = false;
  })().catch((err) => {
    runtimeReady = null;
    throw err;
  });
  return runtimeReady;
}

function session(
  backend: DepthBackend,
  id: number,
  allowDownload: boolean,
  lowMemory: boolean,
): Promise<Ort.InferenceSession> {
  let s = sessions.get(backend);
  if (!s) {
    s = (async () => {
      const variant = VARIANTS[backend];
      const url = variantUrl(variant);
      if (!allowDownload) {
        const cache = await caches.open(DEPTH_CACHE).catch(() => null);
        if (!(await cache?.match(url))) throw new NotCachedError();
      }
      let bytes: ArrayBuffer | null = await fetchCached(url, variant.bytes, (loaded, total) =>
        post({ type: 'progress', id, phase: 'model', loaded, total }),
      );
      post({ type: 'progress', id, phase: 'compile', loaded: 0, total: 1 });
      const created = ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
        // The arena keeps every buffer the runtime ever asked for, and the
        // memory pattern pre-plans a peak; on a phone both are memory the
        // tab is charged for and cannot get back.
        enableCpuMemArena: !lowMemory,
        enableMemPattern: !lowMemory,
      });
      // The runtime has its own copy now; ours need not outlive the call.
      bytes = null;
      return created;
    })();
    sessions.set(backend, s);
    s.catch(() => sessions.delete(backend));
  }
  return s;
}

async function infer(backend: DepthBackend, req: DepthRequest & { type: 'estimate' }) {
  const s = await session(backend, req.id, req.allowDownload, req.lowMemory);
  const [mw, mh] = modelInputSize(req.width, req.height, req.inputSize);
  const rgb = resampleRGB(req.rgba, req.width, req.height, mw, mh);
  const input = new ort.Tensor('float32', toModelTensor(rgb, mw, mh), [1, 3, mh, mw]);
  post({ type: 'progress', id: req.id, phase: 'infer', loaded: 0, total: 1 });
  const t0 = performance.now();
  const out = await s.run({ [s.inputNames[0]!]: input });
  const inferMs = performance.now() - t0;
  const tensor = out[s.outputNames[0]!]!;
  const raw = (await tensor.getData()) as Float32Array;
  const [, oh, ow] = tensor.dims as [number, number, number];
  input.dispose();
  tensor.dispose();
  return { raw, ow, oh, rgb, mw, mh, inferMs };
}

self.onmessage = async (e: MessageEvent<DepthRequest>) => {
  const req = e.data;
  if (req.type !== 'estimate') return;
  try {
    await loadRuntime(req.id);
    let backend: DepthBackend = req.backend;
    let result: Awaited<ReturnType<typeof infer>>;
    try {
      result = await infer(backend, req);
    } catch (err) {
      if (err instanceof NotCachedError || backend === 'wasm') throw err;
      // Drop the failed GPU session before the CPU one is built beside it.
      sessions.delete('webgpu');
      // The GPU path can fail late — a driver without a kernel the graph
      // wants, a lost device. The CPU path is slower but always there.
      console.warn('[depth] WebGPU failed, falling back to WebAssembly:', err);
      backend = 'wasm';
      result = await infer(backend, req);
    }

    post({ type: 'progress', id: req.id, phase: 'refine', loaded: 0, total: 1 });
    // The network may answer at a size other than its input only by a
    // multiple-of-14 floor; the guide it saw is resampled to match.
    const guideLow =
      result.ow === result.mw && result.oh === result.mh
        ? result.rgb
        : resampleRGB(rgbaFrom(result.rgb, result.mw, result.mh), result.mw, result.mh, result.ow, result.oh);
    const up = jointBilateralUpsample(result.raw, result.ow, result.oh, guideLow, req.rgba, req.width, req.height);
    const depth = normaliseDisparity(up);
    post(
      {
        type: 'result',
        id: req.id,
        width: req.width,
        height: req.height,
        depth,
        backend,
        variant: VARIANTS[backend].id,
        inferMs: Math.round(result.inferMs),
      },
      [depth.buffer],
    );
  } catch (err) {
    post({
      type: 'error',
      id: req.id,
      code: err instanceof NotCachedError ? 'not-cached' : 'failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
}

function rgbaFrom(rgb: Float32Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = rgb[i * 3]! * 255;
    out[i * 4 + 1] = rgb[i * 3 + 1]! * 255;
    out[i * 4 + 2] = rgb[i * 3 + 2]! * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}
