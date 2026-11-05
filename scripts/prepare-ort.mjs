import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(root, 'public/ort'), { recursive: true });
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) await rm(resolve(root, 'public/ort', name), { force: true });
for (const name of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  await copyFile(resolve(root, 'node_modules/onnxruntime-web/dist', name), resolve(root, 'public/ort', name));
}
