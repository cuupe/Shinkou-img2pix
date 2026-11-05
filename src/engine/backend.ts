import { executeCpuStep, pixelateWithExecutor } from './pixelate';
import type { PipelineStep, PipelineOutput } from './pixelate';
import { applyAiGuidance } from './ai-guidance';
import type { AiAnalysis } from './ai-runtime';
import { getAccelerator } from './webgpu';
import type { Accelerator } from './webgpu';
import type { PixelResult, PixelSource, Settings } from './types';

const loadAi = async (source: PixelSource, cpu: boolean) => (await import('./ai-runtime')).analyzeEdges(source, cpu);
export async function pixelateAccelerated(source: PixelSource, settings: Settings, load: () => Promise<Accelerator> = getAccelerator, analyze: typeof loadAi = loadAi): Promise<PixelResult> {
  const start = performance.now();
  let ai: AiAnalysis | undefined, aiError: string | undefined;
  if (settings.method === 'structure' && settings.aiStrength > 0) {
    try { ai = await analyze(source, settings.backend === 'cpu'); }
    catch (error) { aiError = `AI 未生效：${error instanceof Error ? error.message : String(error)}`; }
  }
  const run = async (execute: (step: PipelineStep) => Promise<PipelineOutput>) => {
    const result = await pixelateWithExecutor(source, settings, async step => {
      const output = await execute(step);
      if (ai && step.kind === 'prepare' && step.withFeatures && output?.features) {
        output.aiImportance = output.features.importance.slice();
        applyAiGuidance({ data: output.data, width: step.width, height: step.height }, { ...output.features, importance: output.aiImportance }, ai.map, settings.aiStrength);
      }
      return output;
    });
    if (ai) { result.execution.ai = ai.info; result.execution.timings.ai = ai.info.duration; }
    else if (aiError) result.execution.ai = { backend: 'none', model: 'TEED', reason: aiError, duration: 0, cached: false };
    result.duration = performance.now() - start; return result;
  };
  const cpu = async (reason: string) => {
    const result = await run(async step => executeCpuStep(step)); result.execution.reason = reason; return result;
  };
  if (settings.backend === 'cpu') return cpu('已选择 CPU');
  // Small sampling jobs cost less on CPU than GPU upload, dispatch and readback.
  if (settings.backend === 'auto' && (settings.method === 'sample' || source.width * source.height < 65536)) return cpu('当前任务较小，自动使用 CPU 以减少传输开销');
  try {
    const gpu = await load(); gpu.stages.clear();
    const result = await run(step => gpu.execute(step));
    result.execution = { ...result.execution, backend: 'gpu', device: gpu.deviceName, gpuStages: [...gpu.stages] };
    result.duration = performance.now() - start; return result;
  } catch (error) {
    // Retry the entire immutable source on CPU: no partial GPU image is exported.
    return cpu(`GPU 回退：${error instanceof Error ? error.message : String(error)}`);
  }
}
