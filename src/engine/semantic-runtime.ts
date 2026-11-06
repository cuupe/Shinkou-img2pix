import type { InferenceSession } from 'onnxruntime-web';
import type { ExecutionInfo, PixelSource, SemanticFace } from './types';
import { detectAnimeFaces } from './face-detection';
import { sourceEyeHighlights, sourceEyeDetails, sourceMouthDetail } from './semantic-features';
import card from '../../public/models/anime-landmarks-model.json';

export interface SemanticAnalysis { faces: SemanticFace[]; info: NonNullable<ExecutionInfo['semantic']> }
const importOrt = () => import('onnxruntime-web/webgpu');
let runtime: ReturnType<typeof importOrt> | undefined, bytes: Promise<Uint8Array<ArrayBuffer>> | undefined;
type Session = { session: InferenceSession; backend: 'webgpu' | 'wasm'; device?: string };
const sessions = new Map<boolean, Promise<Session>>();
let last: { source: PixelSource; cpu: boolean; value: SemanticAnalysis } | undefined;
let gpuFailure: string | undefined;
async function modelBytes() {
  return bytes ??= (async () => {
    const response = await fetch('/models/anime-landmarks.onnx');
    if (!response.ok) throw new Error(`五官模型读取失败 (${response.status})`);
    const buffer = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== card.sha256) throw new Error('五官模型校验失败');
    return new Uint8Array(buffer);
  })();
}
async function getSession(cpu: boolean): Promise<Session> {
  if (!sessions.has(cpu)) sessions.set(cpu, (async () => {
    const ort = await (runtime ??= importOrt());
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', location.origin).href, mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', location.origin).href };
    if (!cpu) {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter || adapter.info.isFallbackAdapter) throw new Error('五官模型未找到硬件适配器');
      ort.env.webgpu.adapter = adapter;
      // The NHWC rewrite produced incorrect HRNet heatmaps on the tested Intel
      // driver. Native NCHW matches CPU to <1e-6 and still dispatches hardware work.
      const session = await ort.InferenceSession.create(await modelBytes(), { executionProviders: [{ name: 'webgpu', preferredLayout: 'NCHW' }, 'wasm'], graphOptimizationLevel: 'all' });
      const device = await ort.env.webgpu.device;
      void device.lost.then(info => { gpuFailure = info.message || '五官模型 GPU 设备丢失'; });
      return { session, backend: 'webgpu', device: device.adapterInfo?.description || [device.adapterInfo?.vendor, device.adapterInfo?.architecture].filter(Boolean).join(' ') };
    }
    return { session: await ort.InferenceSession.create(await modelBytes(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), backend: 'wasm' };
  })());
  return sessions.get(cpu)!;
}

export async function analyzeSemantics(source: PixelSource, cpu: boolean): Promise<SemanticAnalysis> {
  const start = performance.now();
  if (last?.source === source && last.cpu === cpu && !(last.value.info.backend === 'webgpu' && gpuFailure)) return { ...last.value, info: { ...last.value.info, duration: performance.now() - start, cached: true } };
  const original = new OffscreenCanvas(source.width, source.height), context = original.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(source.data), source.width, source.height), 0, 0);
  context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#fff'; context.fillRect(0, 0, source.width, source.height);
  const ratio = Math.min(1, 384 / Math.max(source.width, source.height));
  const small = new OffscreenCanvas(Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio))), c = small.getContext('2d', { willReadFrequently: true })!;
  c.drawImage(original, 0, 0, small.width, small.height);
  const rgba = c.getImageData(0, 0, small.width, small.height).data;
  const gray = Uint8Array.from({ length: small.width * small.height }, (_, p) => Math.round(.299 * rgba[p * 4] + .587 * rgba[p * 4 + 1] + .114 * rgba[p * 4 + 2]));
  const boxes = detectAnimeFaces(gray, small.width, small.height);
  if (!boxes.length) {
    const value: SemanticAnalysis = { faces: [], info: { backend: 'none', model: card.name, faces: 0, duration: performance.now() - start, cached: false, reason: '未检测到适用的正面动漫人脸，使用通用色块重构' } };
    last = { source, cpu, value }; return value;
  }
  let session: Session, reason: string | undefined;
  try { if (!cpu && gpuFailure) throw new Error(gpuFailure); session = await getSession(cpu); }
  catch (error) { if (cpu) throw error; reason = `五官 GPU 回退：${error instanceof Error ? error.message : String(error)}`; session = await getSession(true); }
  const faces: SemanticFace[] = [];
  const ort = await (runtime ??= importOrt());
  for (const [x, y, w, h] of boxes) {
    const side = Math.max(w / small.width * source.width, h / small.height * source.height) * 1.25;
    const left = (x + w / 2) / small.width * source.width - side / 2, top = (y + h / 2) / small.height * source.height - side / 2;
    const crop = new OffscreenCanvas(256, 256), ctx = crop.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 256); ctx.drawImage(original, left, top, side, side, 0, 0, 256, 256);
    const pixels = ctx.getImageData(0, 0, 256, 256).data, input = new Float32Array(3 * 256 * 256);
    for (let k = 0; k < 3; k++) for (let p = 0; p < 256 * 256; p++) input[k * 256 * 256 + p] = (pixels[p * 4 + k] / 255 - card.normalization.mean[k]) / card.normalization.std[k];
    const tensor = new ort.Tensor('float32', input, [1, 3, 256, 256]);
    let output;
    try {
      try { output = await session.session.run({ image: tensor }); }
      catch (error) {
        if (session.backend === 'wasm') throw error;
        reason = `五官 GPU 推理回退：${error instanceof Error ? error.message : String(error)}`;
        gpuFailure = reason; session = await getSession(true); output = await session.session.run({ image: tensor });
      }
      const heat = output.heatmaps.data as Float32Array, points: SemanticFace['points'] = [];
      for (let k = 0; k < 28; k++) {
        const offset = k * 64 * 64; let best = 0;
        for (let p = 1; p < 64 * 64; p++) if (heat[offset + p] > heat[offset + best]) best = p;
        let hx = best % 64, hy = Math.floor(best / 64);
        if (hx > 0 && hx < 63 && hy > 0 && hy < 63) { hx += .25 * Math.sign(heat[offset + best + 1] - heat[offset + best - 1]); hy += .25 * Math.sign(heat[offset + best + 64] - heat[offset + best - 64]); }
        points.push([(left + hx / 64 * side) / source.width, (top + hy / 64 * side) / source.height, heat[offset + best]]);
      }
      const mean = points.slice(11).reduce((s, p) => s + p[2], 0) / 17;
      // Reject low-confidence/implausible proposals. No invented face on scenery.
      if (mean >= .55 && points[11][0] < points[19][0] && points[24][1] > Math.min(points[12][1], points[18][1]) && Math.abs(points[12][1] - points[18][1]) < .35 * side / source.height && points.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1)) {
        const highlights = sourceEyeHighlights(source, points);
        faces.push({ points, box: [x / small.width, y / small.height, w / small.width, h / small.height], highlights: highlights.map(h => h.position), highlightColors: highlights.map(h => h.color), eyes: sourceEyeDetails(source, points), mouth: sourceMouthDetail(source, points) });
      }
    } finally { tensor.dispose(); if (output) Object.values(output).forEach(t => t.dispose()); }
  }
  const value: SemanticAnalysis = { faces, info: { backend: session.backend, model: card.name, faces: faces.length, duration: performance.now() - start, cached: false, reason: reason || (faces.length ? undefined : '五官置信度不足，使用通用色块重构'), device: session.device } };
  last = { source, cpu, value }; return value;
}
