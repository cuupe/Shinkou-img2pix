import { pixelate, pixelateWithExecutor } from './pixelate';
import { getAccelerator } from './webgpu';
import type { Accelerator } from './webgpu';
import type { PixelResult, PixelSource, Settings } from './types';

export async function pixelateAccelerated(source: PixelSource, settings: Settings, load: () => Promise<Accelerator> = getAccelerator): Promise<PixelResult> {
  const start = performance.now();
  const cpu = (reason: string) => {
    const result = pixelate(source, settings); result.execution.reason = reason; result.duration = performance.now() - start; return result;
  };
  if (settings.backend === 'cpu') return cpu('已选择 CPU');
  // Small sampling jobs cost less on CPU than GPU upload, dispatch and readback.
  if (settings.backend === 'auto' && (settings.method === 'sample' || source.width * source.height < 65536)) return cpu('当前任务较小，自动使用 CPU 以减少传输开销');
  try {
    const gpu = await load(); gpu.stages.clear();
    const result = await pixelateWithExecutor(source, settings, step => gpu.execute(step));
    result.execution = { ...result.execution, backend: 'gpu', device: gpu.deviceName, gpuStages: [...gpu.stages] };
    result.duration = performance.now() - start; return result;
  } catch (error) {
    // Retry the entire immutable source on CPU: no partial GPU image is exported.
    return cpu(`GPU 回退：${error instanceof Error ? error.message : String(error)}`);
  }
}
