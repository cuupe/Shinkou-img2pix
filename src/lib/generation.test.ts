import { describe, expect, it } from 'vitest';
import { buildGenerationGraph, historyImage } from './generation';
import manifest from '../../scripts/generation-models.json';

describe('local generative image edit', () => {
  it('uses exactly the model filenames installed by the pinned download manifest', () => {
    const graph = buildGenerationGraph('source.png', 512, 512, '', 1);
    expect([graph['1'].inputs.unet_name, graph['2'].inputs.clip_name, graph['3'].inputs.vae_name]).toEqual(manifest.models.map(m => m.path.split('/').at(-1)));
  });
  it('conditions on the uploaded source and keeps the text encoder off the 8GB GPU', () => {
    const graph = buildGenerationGraph('source-unique.png', 512, 384, 'redraw', 123);
    expect(graph['4'].inputs.image).toBe('source-unique.png');
    expect(graph['8'].inputs.latent).toEqual(['7', 0]);
    expect(graph['7'].inputs.pixels).toEqual(['4', 0]);
    expect(graph['2'].inputs.device).toBe('cpu');
    expect(graph['13'].inputs).toEqual({ steps: 4, width: 512, height: 384 });
    expect(graph['14'].inputs).toEqual({ width: 512, height: 384, batch_size: 1 });
    expect(graph['11'].inputs.noise_seed).toBe(123);
    for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) expect(graph[value[0]]).toBeDefined();
    }
  });
  it('waits for completion and accepts only this job final output', () => {
    const image = { filename: 'a.png', subfolder: 'Shinkou', type: 'output' };
    expect(historyImage({}, 'a')).toBeUndefined();
    expect(historyImage({ b: { status: { completed: true }, outputs: { '17': { images: [image] } } } }, 'a')).toBeUndefined();
    expect(historyImage({ a: { status: { completed: false }, outputs: { '17': { images: [image] } } } }, 'a')).toBeUndefined();
    expect(historyImage({ a: { status: { completed: true }, outputs: { '17': { images: [image] } } } }, 'a')).toEqual(image);
    expect(() => historyImage({ a: { status: { completed: true }, outputs: { preview: { images: [image] } } } }, 'a')).toThrow('没有输出');
  });
  it('surfaces inference errors rather than silently returning a traditional result', () => {
    expect(() => historyImage({ a: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } }, 'a')).toThrow('CUDA out of memory');
  });
});
