import shader from './gpu.wgsl?raw';
import { executeCpuStep, oklab } from './pixelate';
import type { PipelineOutput, PipelineStep } from './pixelate';
import type { PixelSource } from './types';

export interface Accelerator {
  deviceName: string;
  stages: Set<string>;
  execute(step: PipelineStep): Promise<PipelineOutput>;
}

/** One device per processing worker. Source upload is reused between parameter edits. */
export class WebGpuAccelerator implements Accelerator {
  readonly stages = new Set<string>();
  private source?: PixelSource;
  private sourceBuffer?: GPUBuffer;
  private lost = false;
  private constructor(private device: GPUDevice, public deviceName: string, private pipelines: Record<string, GPUComputePipeline>, private lut: GPUBuffer) {
    void device.lost.then(() => { this.lost = true; this.sourceBuffer?.destroy(); this.lut.destroy(); });
  }

  static async create(): Promise<WebGpuAccelerator> {
    if (!navigator.gpu) throw new Error('当前运行时未提供 WebGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未找到可用的 WebGPU 适配器');
    if (adapter.info.isFallbackAdapter) throw new Error('仅检测到软件适配器');
    const device = await adapter.requestDevice();
    try {
      const module = device.createShaderModule({ code: shader, label: 'Pixel processing' });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(m => m.type === 'error');
      if (errors.length) throw new Error(errors.map(e => `${e.lineNum}: ${e.message}`).join('; '));
      const entries = ['sample', 'adjust', 'ridges', 'support', 'quantize'];
      const pipelines = Object.fromEntries(await Promise.all(entries.map(async entryPoint => [entryPoint, await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })])));
      const values = Float32Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
      const lut = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(lut, 0, values);
      return new WebGpuAccelerator(device, adapter.info.description || [adapter.info.vendor, adapter.info.architecture].filter(Boolean).join(' ') || 'WebGPU 硬件适配器', pipelines, lut);
    } catch (error) { device.destroy(); throw error; }
  }

  async execute(step: PipelineStep): Promise<PipelineOutput> {
    if (this.lost) throw new Error('GPU 设备连接已丢失');
    if (step.kind === 'quantize' && (step.settings.dither === 'floyd' || !step.palette.length)) return executeCpuStep(step);
    const { device } = this, temporary: GPUBuffer[] = [];
    const buffer = (size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      if (size > device.limits.maxBufferSize || ((usage & GPUBufferUsage.STORAGE) && size > device.limits.maxStorageBufferBindingSize)) throw new Error('图像超过 GPU 缓冲区限制');
      const out = device.createBuffer({ size, usage }); temporary.push(out); return out;
    };
    const storage = (size: number) => buffer(size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const upload = (out: GPUBuffer, data: ArrayBufferView) => device.queue.writeBuffer(out, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    const count = step.width * step.height, bytes = count * 4;
    const scopes: GPUErrorFilter[] = ['internal', 'out-of-memory', 'validation'];
    scopes.forEach(scope => device.pushErrorScope(scope));
    let scopePopped = false;
    try {
      const uniform = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), values = new ArrayBuffer(48);
      new Uint32Array(values).set([step.width, step.height, step.kind === 'prepare' ? step.source.width : 0, step.kind === 'prepare' ? step.source.height : 0, +step.settings.transparent, +step.settings.detail, step.kind === 'quantize' ? step.palette.length : 0, +(step.settings.dither === 'ordered')]);
      new Float32Array(values).set([(1 + step.settings.contrast / 100) ** 2, 1 + step.settings.saturation / 100, step.settings.brightness * 2.55, step.settings.ditherAmount / 100], 8);
      device.queue.writeBuffer(uniform, 0, values);
      const encoder = device.createCommandEncoder();
      const dispatch = (name: string, bindings: Record<number, GPUBuffer>) => {
        const pipeline = this.pipelines[name];
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: Object.entries({ 0: uniform, ...bindings }).map(([binding, value]) => ({ binding: +binding, resource: { buffer: value } })) });
        const pass = encoder.beginComputePass({ label: name }); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(step.width / 8), Math.ceil(step.height / 8)); pass.end();
      };
      const adjusted = storage(bytes);
      let featureBuffer: GPUBuffer | undefined;
      if (step.kind === 'prepare') {
        if (this.source !== step.source || !this.sourceBuffer) {
          this.sourceBuffer?.destroy(); this.sourceBuffer = undefined; this.source = undefined;
          if (step.source.data.byteLength > device.limits.maxStorageBufferBindingSize) throw new Error('原图超过 GPU 缓冲区限制');
          const sourceBuffer = device.createBuffer({ size: step.source.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
          upload(sourceBuffer, step.source.data); this.sourceBuffer = sourceBuffer; this.source = step.source;
        }
        const sampled = storage(bytes);
        dispatch('sample', { 1: this.sourceBuffer, 2: sampled, 3: this.lut });
        dispatch('adjust', { 1: sampled, 2: adjusted });
        if (step.withFeatures) {
          const raw = storage(count * 8); featureBuffer = storage(count * 16);
          dispatch('ridges', { 1: adjusted, 4: raw });
          dispatch('support', { 1: adjusted, 4: raw, 5: featureBuffer });
        }
      } else {
        const input = storage(bytes); upload(input, step.data);
        const labs = new Float32Array(step.palette.length * 4), colors = new Uint32Array(step.palette.length);
        step.palette.forEach((color, i) => { labs.set(oklab(color), i * 4); colors[i] = (color[0] | color[1] << 8 | color[2] << 16 | 255 << 24) >>> 0; });
        const labBuffer = storage(labs.byteLength), paletteBuffer = storage(colors.byteLength); upload(labBuffer, labs); upload(paletteBuffer, colors);
        dispatch('quantize', { 1: input, 2: adjusted, 3: this.lut, 6: labBuffer, 7: paletteBuffer });
      }
      const readback = (from: GPUBuffer, size: number) => { const out = buffer(size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ); encoder.copyBufferToBuffer(from, 0, out, 0, size); return out; };
      const pixels = readback(adjusted, bytes), featureReadback = featureBuffer ? readback(featureBuffer, count * 16) : undefined;
      device.queue.submit([encoder.finish()]);
      const errors = await Promise.all(scopes.map(() => device.popErrorScope())); scopePopped = true;
      const error = errors.find(Boolean); if (error) throw new Error(error.message);
      const maps = await Promise.allSettled([pixels.mapAsync(GPUMapMode.READ), ...(featureReadback ? [featureReadback.mapAsync(GPUMapMode.READ)] : [])]);
      for (const map of maps) if (map.status === 'rejected') throw map.reason;
      const data = new Uint8ClampedArray(pixels.getMappedRange().slice(0)); pixels.unmap();
      if (step.kind === 'quantize') { step.data.set(data); this.stages.add('感知颜色匹配'); return; }
      this.stages.add('线性光面积采样'); this.stages.add('色彩调整');
      if (!featureReadback) return { data };
      const packed = new Float32Array(featureReadback.getMappedRange()), importance = new Float32Array(count), luminance = new Float32Array(count), coherence = new Float32Array(count);
      for (let i = 0; i < count; i++) { importance[i] = packed[i * 4]; luminance[i] = packed[i * 4 + 1]; coherence[i] = packed[i * 4 + 2]; }
      featureReadback.unmap(); this.stages.add('细线与区域分析');
      return { data, features: { importance, luminance, coherence } };
    } finally { if (!scopePopped) await Promise.all(scopes.map(() => device.popErrorScope())); temporary.forEach(b => b.destroy()); }
  }
}

let cached: Promise<Accelerator> | undefined;
export const getAccelerator = () => cached ??= WebGpuAccelerator.create();
