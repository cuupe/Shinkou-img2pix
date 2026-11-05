import { edgePreview, teedInput } from './ai-guidance';
import type { EdgeMap } from './ai-guidance';
import type { ExecutionInfo, PixelSource } from './types';
import card from '../../public/models/teed-model.json';
import type { InferenceSession } from 'onnxruntime-web';

export interface AiAnalysis { map: EdgeMap; info: NonNullable<ExecutionInfo['ai']> }
type Session = { session: InferenceSession; backend: 'webgpu' | 'wasm'; device?: string };
let runtime: ReturnType<typeof importOrt> | undefined;
const importOrt = () => import('onnxruntime-web/webgpu');
let model: Promise<Uint8Array<ArrayBuffer>> | undefined;
const sessions = new Map<string, Promise<Session>>();
let last: { source: PixelSource; cpu: boolean; analysis: AiAnalysis } | undefined;
let gpuFailure: string | undefined;

async function modelBytes() {
  return model ??= (async () => {
    const response = await fetch('/models/teed-512.onnx');
    if (!response.ok) throw new Error(`模型读取失败 (${response.status})`);
    const bytes = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== card.sha256) throw new Error('模型校验失败，请重新安装应用');
    return new Uint8Array(bytes);
  })();
}
async function getSession(cpu: boolean): Promise<Session> {
  const key = cpu ? 'wasm' : 'webgpu';
  if (!sessions.has(key)) sessions.set(key, (async () => {
    const ort = await (runtime ??= importOrt());
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', location.origin).href, mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', location.origin).href };
    if (!cpu) {
      if (!navigator.gpu) throw new Error('当前运行时未提供 WebGPU');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter || adapter.info.isFallbackAdapter) throw new Error('未找到 AI 硬件适配器');
      ort.env.webgpu.adapter = adapter; ort.env.webgpu.powerPreference = 'high-performance';
      const session = await ort.InferenceSession.create(await modelBytes(), { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' });
      const device = await ort.env.webgpu.device;
      if (device.adapterInfo?.isFallbackAdapter) { await session.release(); throw new Error('AI 运行时选择了软件适配器'); }
      void device.lost.then(info => { gpuFailure = `AI GPU 设备丢失：${info.message}`; });
      return { session, backend: 'webgpu', device: device.adapterInfo?.description || [device.adapterInfo?.vendor, device.adapterInfo?.architecture].filter(Boolean).join(' ') || 'WebGPU 硬件适配器' };
    }
    return { session: await ort.InferenceSession.create(await modelBytes(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), backend: 'wasm' };
  })());
  return sessions.get(key)!;
}

export async function analyzeEdges(source: PixelSource, cpu: boolean): Promise<AiAnalysis> {
  const start = performance.now();
  if (last?.source === source && last.cpu === cpu && !(last.analysis.info.backend === 'webgpu' && gpuFailure)) {
    return { ...last.analysis, info: { ...last.analysis.info, duration: performance.now() - start, cached: true } };
  }
  const ratio = Math.min(1, 512 / Math.max(source.width, source.height));
  const contentWidth = Math.max(1, Math.round(source.width * ratio)), contentHeight = Math.max(1, Math.round(source.height * ratio));
  const canvas = new OffscreenCanvas(512, 512), context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, 512, 512);
  const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(source.data), source.width, source.height));
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'; context.drawImage(bitmap, 0, 0, contentWidth, contentHeight); bitmap.close();
  const data = teedInput(context.getImageData(0, 0, 512, 512).data), ort = await (runtime ??= importOrt());
  const input = new ort.Tensor('float32', data, [1, 3, 512, 512]);
  let session: Session, reason = gpuFailure;
  try {
    if (cpu || gpuFailure) session = await getSession(true);
    else try { session = await getSession(false); } catch (error) {
      reason = `AI GPU 回退：${error instanceof Error ? error.message : String(error)}`; gpuFailure = reason; session = await getSession(true);
    }
    let outputs;
    try { outputs = await session.session.run({ image: input }); }
    catch (error) {
      if (session.backend === 'wasm') throw error;
      reason = `AI GPU 回退：${error instanceof Error ? error.message : String(error)}`; gpuFailure = reason; session = await getSession(true);
      outputs = await session.session.run({ image: input });
    }
    let values: Float32Array;
    try { values = Float32Array.from(await outputs.edges.getData() as Float32Array); }
    finally { Object.values(outputs).forEach(t => t.dispose()); }
    if (values.length !== 512 * 512 || values.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('AI 输出不符合边缘置信图格式');
    // TEED's fused Smish logits have a background near sigmoid(0)=0.5.
    // Display/use only the positive response, not gray background as confidence.
    const response = Float32Array.from(values, v => Math.max(0, Math.min(1, (v - .5) * 2)));
    const map: EdgeMap = { data: response, width: 512, height: 512, contentWidth, contentHeight };
    const analysis: AiAnalysis = { map, info: { backend: session.backend, device: session.device, model: 'TEED', duration: performance.now() - start, cached: false, reason, preview: edgePreview(map) } };
    last = { source, cpu, analysis }; return analysis;
  } finally { input.dispose(); }
}
