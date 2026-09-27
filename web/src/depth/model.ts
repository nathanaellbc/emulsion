/**
 * The depth model: Depth Anything V2 Small, as exported to ONNX.
 *
 * This is the network the `Depth-Anything-V2` folder beside this app defines
 * (`depth_anything_v2/dpt.py`, encoder 'vits'), with the official Small
 * checkpoint's weights. The fp16 export was checked against that PyTorch code
 * on the Space's own demo images: correlation 1.00000, mean error 0.04–0.12 %
 * of the disparity range. The int8 export, used only where the GPU path is
 * unavailable, lands within 0.3–1.4 %.
 *
 * Small rather than the Space's Large: Small is Apache-2.0, Base and Large are
 * CC-BY-NC-4.0 (no commercial use), and Large is 335 M parameters — over half
 * a gigabyte even in fp16, which no phone should be asked to download to blur
 * a background. The architecture is the same; the preprocessing constants
 * below are the ones `image2tensor` uses.
 *
 * The weights are fetched from the Hugging Face hub on first use, pinned to a
 * revision so the file under a cached URL can never change, and kept in a
 * Cache Storage bucket of their own — deliberately *not* named `emulsion-*`,
 * which the service worker deletes on every app update. A model downloaded
 * once stays downloaded across releases, and works offline thereafter.
 */

export const DEPTH_MODEL = {
  name: 'Depth Anything V2 Small',
  license: 'Apache-2.0',
  repo: 'onnx-community/depth-anything-v2-small',
  revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d',
  /** `image2tensor`: the short side goes to 518, both sides to a multiple of 14. */
  inputSize: 518,
  multipleOf: 14,
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
} as const;

export type DepthBackend = 'webgpu' | 'wasm';

export interface ModelVariant {
  id: 'fp16' | 'int8';
  file: string;
  bytes: number;
  backend: DepthBackend;
  /**
   * The ONNX Runtime binary this backend runs on: the WebGPU build (asyncify,
   * which also carries the CPU kernels for the fallback) or the plain
   * WebAssembly one, half its size.
   */
  runtimeBytes: number;
}

/**
 * fp16 on the GPU, where WebGPU exists and can do half-precision arithmetic;
 * int8 on the CPU (WebAssembly) everywhere else — the CPU kernels for int8 are
 * the fast ones, and fp16 there would be emulated.
 */
export const VARIANTS: Record<DepthBackend, ModelVariant> = {
  webgpu: {
    id: 'fp16',
    file: 'onnx/model_fp16.onnx',
    bytes: 49_642_442,
    backend: 'webgpu',
    runtimeBytes: 26_781_914,
  },
  wasm: {
    id: 'int8',
    file: 'onnx/model_quantized.onnx',
    bytes: 27_258_801,
    backend: 'wasm',
    runtimeBytes: 14_239_900,
  },
};

/**
 * How depth estimation runs on this device. A phone's browser tab lives under
 * a hard memory ceiling — iOS Safari kills the page outright past it, with no
 * error to catch — and the WebGL render graph is already inside that ceiling
 * when the network starts. So a phone gets a smaller network input (the
 * attention matrices scale with the square of the token count: 392 px on the
 * short side is about a third of 518's), a smaller guide, and a worker that
 * is torn down after every photograph, because WebAssembly memory never
 * shrinks and a WebGPU device holds its buffers for as long as it lives.
 */
export interface DepthProfile {
  backend: DepthBackend;
  /** The short side the network sees, a multiple of 14. */
  inputSize: number;
  /** Long edge of the guide the depth is refined to. */
  guideMaxEdge: number;
  /** Tear the worker down after each estimate, and keep the runtime's arenas off. */
  lowMemory: boolean;
}

/** iPhone, iPod, and the iPad that reports itself as a Mac. Page only. */
export function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * The profile for this device. Called on the page, not in the worker: it
 * needs matchMedia.
 *
 * iOS runs the CPU path. ONNX Runtime's WebGPU backend on Safari is the
 * least-tested pairing it has, it would put a second GPU device beside the
 * page's WebGL context, and its runtime binary is twice the plain one's —
 * WebKit compiles every byte of it into memory the tab is charged for. The
 * CPU path is slower (a few seconds at 392 px) and survives.
 */
export async function depthProfile(): Promise<DepthProfile> {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
  if (isAppleMobile()) return { backend: 'wasm', inputSize: 392, guideMaxEdge: 1024, lowMemory: true };
  const backend = await preferredBackend();
  return coarse
    ? { backend, inputSize: 392, guideMaxEdge: 1024, lowMemory: true }
    : { backend, inputSize: DEPTH_MODEL.inputSize, guideMaxEdge: 1536, lowMemory: false };
}

/** Its own bucket: see the header for why this is not `emulsion-…`. */
export const DEPTH_CACHE = 'emulsion.depth.v1';

export function variantUrl(v: ModelVariant): string {
  return `https://huggingface.co/${DEPTH_MODEL.repo}/resolve/${DEPTH_MODEL.revision}/${v.file}`;
}

/** Whether this device can run the fp16 model on its GPU. Works on a page and in a worker. */
export async function preferredBackend(): Promise<DepthBackend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GPUAdapterLike | null> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter && adapter.features.has('shader-f16') ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

interface GPUAdapterLike {
  features: { has(name: string): boolean };
}

/** True when the weights this device would use are already on it. */
export async function isModelCached(backend?: DepthBackend): Promise<boolean> {
  try {
    const cache = await caches.open(DEPTH_CACHE);
    const v = VARIANTS[backend ?? (await preferredBackend())];
    return (await cache.match(variantUrl(v))) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Fetches `url` through the depth cache, reporting progress, and returns its
 * bytes — one copy of them.
 *
 * On a miss the download is streamed straight into the cache and read back,
 * rather than gathered in memory and then copied into a Response for the
 * cache: that way held the chunks, the joined buffer and the cache's copy at
 * once, three times the model's size, which on a phone was enough on its own
 * to get the tab killed. A refused cache write (quota, private mode) is not
 * an error: the file is downloaded again into one preallocated buffer and the
 * model runs from memory this time.
 */
export async function fetchCached(
  url: string,
  expectedBytes: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(DEPTH_CACHE);
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  } catch {
    cache = null;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const total = Number(res.headers.get('content-length')) || expectedBytes;

  if (cache && res.body) {
    let loaded = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          onProgress?.(loaded, total);
          controller.enqueue(chunk);
        },
      }),
    );
    try {
      await cache.put(url, new Response(counted, { headers: { 'content-type': 'application/octet-stream' } }));
      const stored = await cache.match(url);
      if (stored) return await stored.arrayBuffer();
    } catch {
      // Quota or a storage-less context: fall through to memory.
    }
    const again = await fetch(url);
    if (!again.ok) throw new Error(`download failed: ${again.status} ${again.statusText} (${url})`);
    return downloadToMemory(again, total, onProgress);
  }
  return downloadToMemory(res, total, onProgress);
}

/** The body into a single buffer, sized from the header and grown only if it lied. */
async function downloadToMemory(
  res: Response,
  total: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  let buffer = new Uint8Array(Math.max(total, 1));
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(Math.max(buffer.byteLength * 2, loaded + value.byteLength));
      grown.set(buffer.subarray(0, loaded));
      buffer = grown;
    }
    buffer.set(value, loaded);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  return loaded === buffer.byteLength ? (buffer.buffer as ArrayBuffer) : buffer.slice(0, loaded).buffer;
}
