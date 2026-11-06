import { invoke } from '@tauri-apps/api/core';
import { generationDimensions, redrawDimensions, redrawPrompt } from '../engine/redraw';
import type { RedrawProfile } from '../engine/redraw';
import { dimensions } from '../engine/pixelate';
import type { PixelSource } from '../engine/types';
import { native } from './image';

type Node = { class_type: string; inputs: Record<string, unknown> };
export type GenerationGraph = Record<string, Node>;
const MODEL = 'flux-2-klein-4b-fp8.safetensors';
const ENCODER = 'qwen_3_4b.safetensors';
const VAE = 'flux2-vae.safetensors';
export interface GenerationOptions { size: number; colors: number; instruction: string; seed: number; profile: RedrawProfile }
const abortError = () => new DOMException('已停止等待；正在运行的本地任务可能继续完成。', 'AbortError');

async function request(operation: string, data: Record<string, unknown> = {}, image?: Uint8Array, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw abortError();
  if (native) {
    const response = await invoke('generation_request', { operation, data, image: image ? Array.from(image) : null });
    if (signal?.aborted) throw abortError();
    return response;
  }
  const routes: Record<string, string> = { info: '/object_info', upload: '/upload/image', submit: '/prompt', cancel: '/queue', history: `/history/${encodeURIComponent(String(data.promptId))}`, image: `/view?${new URLSearchParams(data as Record<string, string>)}` };
  let body: BodyInit | undefined, headers: HeadersInit | undefined;
  if (operation === 'upload' && image) {
    const form = new FormData(); form.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), `shinkou-${crypto.randomUUID()}.png`); body = form;
  } else if (operation === 'submit' || operation === 'cancel') {
    body = JSON.stringify(operation === 'cancel' ? { delete: [data.promptId] } : data); headers = { 'Content-Type': 'application/json' };
  }
  const response = await fetch(`http://127.0.0.1:8188${routes[operation]}`, { method: body ? 'POST' : 'GET', body, headers, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) throw new Error(`本地服务返回 ${response.status}：${(await response.text()).slice(0, 1200)}`);
  if (operation === 'image') return { bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  const text = await response.text(); return text ? JSON.parse(text) : {};
}

/** Core nodes from ComfyUI's official Klein image-edit workflow. The encoder is
 * forced to CPU to leave the 8GB GPU for diffusion. No custom nodes or LoRA. */
export function buildGenerationGraph(image: string, width: number, height: number, prompt: string, seed: number): GenerationGraph {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: ENCODER, type: 'flux2', device: 'cpu' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    '4': { class_type: 'LoadImage', inputs: { image } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    '7': { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['3', 0] } },
    '8': { class_type: 'ReferenceLatent', inputs: { conditioning: ['5', 0], latent: ['7', 0] } },
    '9': { class_type: 'ReferenceLatent', inputs: { conditioning: ['6', 0], latent: ['7', 0] } },
    '10': { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['8', 0], negative: ['9', 0], cfg: 1 } },
    '11': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '12': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '13': { class_type: 'Flux2Scheduler', inputs: { steps: 4, width, height } },
    '14': { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } },
    '15': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['11', 0], guider: ['10', 0], sampler: ['12', 0], sigmas: ['13', 0], latent_image: ['14', 0] } },
    '16': { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['3', 0] } },
    '17': { class_type: 'SaveImage', inputs: { images: ['16', 0], filename_prefix: 'Shinkou/redraw' } },
  };
}

type NodeInfo = { input?: { required?: Record<string, unknown[]> } };
export async function checkGenerationService(signal?: AbortSignal) {
  let info: Record<string, NodeInfo>;
  try { info = await request('info', {}, undefined, signal) as Record<string, NodeInfo>; }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接本地生图服务。请先运行 scripts/start-generation.ps1；首次使用需运行 scripts/setup-generation.ps1。');
  }
  const graph = buildGenerationGraph('source.png', 512, 512, '', 1);
  const missing = Object.values(graph).map(n => n.class_type).filter(type => !info[type]);
  if (missing.length) throw new Error(`ComfyUI 缺少节点：${missing.join('、')}。请使用配套版本或更新服务。`);
  for (const [node, field, model] of [['UNETLoader', 'unet_name', MODEL], ['CLIPLoader', 'clip_name', ENCODER], ['VAELoader', 'vae_name', VAE]]) {
    const choices = info[node]?.input?.required?.[field]?.[0];
    if (!Array.isArray(choices) || !choices.includes(model)) throw new Error(`缺少模型 ${model}。请运行配套安装脚本并重启服务。`);
  }
  return 'FLUX.2 Klein 4B FP8 · 本机服务已就绪';
}

async function referencePng(source: PixelSource) {
  const { width, height } = generationDimensions(source.width, source.height);
  const original = document.createElement('canvas'); original.width = source.width; original.height = source.height;
  original.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(source.data), source.width, source.height), 0, 0);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(original, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('参考图编码失败')), 'image/png'));
  return { width, height, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

export function historyImage(history: unknown, id: string): Record<string, string> | undefined {
  const item = (history as Record<string, { status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] }; outputs?: Record<string, { images?: Record<string, string>[] }> }>)[id];
  if (!item) return;
  if (item.status?.status_str === 'error') {
    const message = item.status.messages?.find(([type]) => type === 'execution_error')?.[1];
    throw new Error(`本地重绘失败：${String(message?.exception_message ?? '请查看 ComfyUI 窗口的错误信息').slice(0, 800)}`);
  }
  // Only the final SaveImage node is accepted; previews and reference uploads are not candidates.
  const image = item.outputs?.['17']?.images?.[0];
  if (image && item.status?.completed) return image;
  if (item.status?.completed) throw new Error('任务完成但没有输出候选图片');
}

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(abortError()); return; }
  const stop = () => { clearTimeout(timer); reject(abortError()); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true });
});

export async function generateRedraw(source: PixelSource, options: GenerationOptions, signal: AbortSignal, progress: (text: string) => void) {
  let promptId: string | undefined;
  let finished = false;
  try {
    progress('检查模型与服务…'); await checkGenerationService(signal);
    const reference = await referencePng(source);
    const uploaded = await request('upload', {}, reference.bytes, signal) as { name: string; subfolder?: string };
    if (!uploaded.name) throw new Error('本地服务未返回参考图文件名');
    const imageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    const target = dimensions(source.width, source.height, options.size);
    const generated = redrawDimensions(source.width, source.height, options.size, options.profile);
    const prompt = redrawPrompt(target.width, target.height, options.colors, options.instruction);
    const graph = buildGenerationGraph(imageName, generated.width, generated.height, prompt, options.seed);
    if (signal.aborted) throw abortError();
    // Once submitted, receive the job id even if the panel closes meanwhile, so
    // its pending queue entry can still be deleted in finally.
    const submitted = await request('submit', { prompt: graph, client_id: crypto.randomUUID() }) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
    if (!submitted.prompt_id) throw new Error(`工作流未通过验证：${JSON.stringify(submitted.node_errors ?? submitted.error ?? submitted).slice(0, 1200)}`);
    promptId = submitted.prompt_id;
    if (signal.aborted) throw abortError();
    progress('正在排队、加载模型或重绘；首次加载可能较慢…');
    const started = performance.now();
    while (performance.now() - started < 20 * 60_000) {
      await delay(1500, signal);
      const image = historyImage(await request('history', { promptId }, undefined, signal), promptId);
      if (!image) continue;
      const output = await request('image', image, undefined, signal) as { bytes: number[] };
      if (!Array.isArray(output.bytes) || output.bytes.length > 32 * 1024 * 1024) throw new Error('候选图像数据无效');
      finished = true;
      return { blob: new Blob([new Uint8Array(output.bytes)], { type: 'image/png' }), prompt, seed: options.seed, width: generated.width, height: generated.height };
    }
    throw new Error('等待超过 20 分钟。可检查本地服务，候选未自动应用。');
  } finally {
    // Delete only this pending job. Never globally interrupt another ComfyUI task.
    if (promptId && !finished) void request('cancel', { promptId }).catch(() => {});
  }
}
