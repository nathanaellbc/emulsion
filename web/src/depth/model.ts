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
}

/**
 * fp16 on the GPU, where WebGPU exists and can do half-precision arithmetic;
 * int8 on the CPU (WebAssembly) everywhere else — the CPU kernels for int8 are
 * the fast ones, and fp16 there would be emulated.
 */
export const VARIANTS: Record<DepthBackend, ModelVariant> = {
  webgpu: { id: 'fp16', file: 'onnx/model_fp16.onnx', bytes: 49_642_442, backend: 'webgpu' },
  wasm: { id: 'int8', file: 'onnx/model_quantized.onnx', bytes: 27_258_801, backend: 'wasm' },
};

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
 * Fetches `url` through the depth cache, reporting progress. A refused cache
 * write (quota, private mode) is not an error — the model still runs, it just
 * downloads again next time.
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
  let buffer: Uint8Array;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total);
    }
    buffer = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) {
      buffer.set(c, o);
      o += c.byteLength;
    }
  } else {
    buffer = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buffer.byteLength, buffer.byteLength);
  }

  try {
    await cache?.put(
      url,
      new Response(buffer.slice(), { headers: { 'content-type': 'application/octet-stream' } }),
    );
  } catch {
    // Quota or a storage-less context: run from memory this time.
  }
  return buffer.buffer as ArrayBuffer;
}
