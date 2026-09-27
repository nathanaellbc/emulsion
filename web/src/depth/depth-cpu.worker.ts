/// <reference lib="webworker" />
/**
 * The plain WebAssembly build of ONNX Runtime: int8 on the CPU. Half the
 * binary of the WebGPU build, which matters most where it runs — on phones,
 * whose browsers compile every byte of it into the tab's memory.
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { VARIANTS } from './model';
import { serveDepth } from './worker-core';

serveDepth(ort, ortWasmUrl, VARIANTS.wasm.runtimeBytes);
