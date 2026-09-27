/// <reference lib="webworker" />
/** The WebGPU build of ONNX Runtime: fp16 on the GPU, with CPU kernels for the fallback. */
import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { VARIANTS } from './model';
import { serveDepth } from './worker-core';

serveDepth(ort, ortWasmUrl, VARIANTS.webgpu.runtimeBytes);
