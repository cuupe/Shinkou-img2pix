import { describe, expect, it, vi } from 'vitest';
import { pixelateAccelerated } from './backend';
import { executeCpuStep, pixelate } from './pixelate';
import { DEFAULT_SETTINGS } from './types';
import type { PixelSource } from './types';

const source: PixelSource = { width: 24, height: 20, data: Uint8ClampedArray.from({ length: 24 * 20 * 4 }, (_, i) => i % 4 === 3 ? 255 : (i * 31) % 256) };

describe('accelerated backend selection and recovery', () => {
  it('never initializes a GPU when CPU is selected', async () => {
    const load = vi.fn(), settings = { ...DEFAULT_SETTINGS, backend: 'cpu' as const };
    const actual = await pixelateAccelerated(source, settings, load);
    expect(load).not.toHaveBeenCalled(); expect(actual.execution.backend).toBe('cpu');
    expect(actual.data).toEqual(pixelate(source, settings).data);
  });
  it('avoids transfer overhead for small automatic jobs', async () => {
    const load = vi.fn(); const actual = await pixelateAccelerated(source, DEFAULT_SETTINGS, load);
    expect(load).not.toHaveBeenCalled(); expect(actual.execution.backend).toBe('cpu');
  });
  it('reports adapter failure and returns the full reference result', async () => {
    const settings = { ...DEFAULT_SETTINGS, backend: 'gpu' as const };
    const actual = await pixelateAccelerated(source, settings, async () => { throw new Error('No hardware adapter'); });
    expect(actual.execution.reason).toContain('No hardware adapter');
    expect(actual.execution.backend).toBe('cpu'); expect(actual.execution.gpuStages).toEqual([]);
    expect(actual.data).toEqual(pixelate(source, settings).data);
  });
  it('restarts from the immutable source after a mid-pipeline device failure', async () => {
    const original = source.data.slice(), settings = { ...DEFAULT_SETTINGS, backend: 'gpu' as const };
    const actual = await pixelateAccelerated(source, settings, async () => ({
      deviceName: 'Failure fixture', stages: new Set(),
      execute: async step => {
        if (step.kind === 'prepare') return executeCpuStep(step);
        step.data.fill(0); throw new Error('Device lost');
      },
    }));
    expect(source.data).toEqual(original); expect(actual.data).toEqual(pixelate(source, settings).data);
    expect(actual.execution.backend).toBe('cpu'); expect(actual.execution.reason).toContain('Device lost');
  });
});
