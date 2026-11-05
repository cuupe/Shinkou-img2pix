import { describe, expect, it, vi } from 'vitest';
import { pixelate, pixelateWithExecutor, executeCpuStep } from './pixelate';
import { pixelateAccelerated } from './backend';
import { sourceEyeHighlights } from './semantic-features';
import { DEFAULT_SETTINGS } from './types';
import type { PixelSource, SemanticFace } from './types';

function fixture(width: number, height: number, color: (x: number, y: number) => number[]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { data, width, height };
}
const settings = { ...DEFAULT_SETTINGS, backend: 'cpu' as const, size: 32, semanticDetail: 0 };
const face: SemanticFace = { box: [.1, .1, .8, .8], points: Array.from({ length: 28 }, () => [.5, .5, 1] as [number, number, number]) };
face.points.splice(11, 6, [.2, .3, 1], [.25, .25, 1], [.35, .3, 1], [.2, .4, 1], [.3, .4, 1], [.35, .4, 1]);
face.points.splice(17, 6, [.6, .3, 1], [.7, .25, 1], [.8, .3, 1], [.6, .4, 1], [.7, .4, 1], [.8, .4, 1]);
face.points.splice(24, 4, [.4, .65, 1], [.5, .68, 1], [.6, .65, 1], [.5, .69, 1]);

describe('low-resolution region reconstruction', () => {
  it('keeps a source-supported low-contrast cartoon mouth visible at a small grid', () => {
    const source = fixture(192, 192, (x, y) => {
      const curve = 90 + 12 * (1 - ((x - 96) / 18) ** 2);
      return x >= 78 && x <= 114 && Math.abs(y - curve) < 2 ? [205, 195, 112, 255] : [240, 235, 140, 255];
    });
    const result = pixelate(source, { ...settings, colors: 8 });
    let dark = 0;
    for (let y = 14; y <= 18; y++) for (let x = 12; x <= 20; x++) if (result.data[(y * 32 + x) * 4] < 225) dark++;
    expect(dark).toBeGreaterThanOrEqual(3);
  });
  it('preserves flat fills, alpha boundaries and the immutable source', () => {
    const source = fixture(96, 72, x => x < 24 ? [200, 0, 100, 0] : [180, 120, 90, 255]), before = source.data.slice();
    const result = pixelate(source, settings);
    expect([result.width, result.height]).toEqual([32, 24]);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) expect([...result.data.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]).toEqual(x < 8 ? [0, 0, 0, 0] : [180, 120, 90, 255]);
    expect(source.data).toEqual(before);
  });
  it('keeps palette membership and budget with deterministic, binary output', () => {
    const source = fixture(100, 80, (x, y) => [x * 2, y * 3, (x + y) % 256, x < 3 ? 0 : 255]);
    for (const palette of ['adaptive', 'pico8'] as const) {
      const result = pixelate(source, { ...settings, colors: 8, palette });
      const allowed = new Set(result.palette.map(c => c.join(',')));
      if (palette === 'adaptive') expect(result.palette.length).toBeLessThanOrEqual(8);
      for (let p = 0; p < result.width * result.height; p++) { expect([0, 255]).toContain(result.data[p * 4 + 3]); if (result.data[p * 4 + 3]) expect(allowed.has([...result.data.slice(p * 4, p * 4 + 3)].join(','))).toBe(true); }
      expect(result.data).toEqual(pixelate(source, { ...settings, colors: 8, palette }).data);
    }
  });
  it('leaves 96/160px and already-small pixel inputs on the existing path', () => {
    const source = fixture(192, 144, (x, y) => [x, y, (x + y) % 256, 255]);
    for (const size of [96, 160]) expect(pixelate(source, { ...settings, size }).data).toEqual(pixelate(source, { ...settings, size, lowResolution: 'source' }).data);
    const small = fixture(24, 24, (x, y) => [x % 2 ? 255 : 0, y % 2 ? 255 : 0, 0, 255]);
    expect(pixelate(small, settings).data).toEqual(pixelate(small, { ...settings, lowResolution: 'source' }).data);
  });
  it('does not invent facial marks on a source with no supporting features', async () => {
    const source = fixture(96, 96, () => [240, 200, 180, 255]);
    const result = await pixelateWithExecutor(source, { ...settings, semanticDetail: 100 }, async step => {
      const output = executeCpuStep(step); if (output) output.faces = [face]; return output;
    });
    expect(new Set(Array.from({ length: 32 * 32 }, (_, p) => [...result.data.slice(p * 4, p * 4 + 4)].join(','))).size).toBe(1);
    expect(sourceEyeHighlights(source, face.points)).toEqual([]);
  });
  it('detects actual enclosed source highlights and rejects connected white backgrounds', () => {
    const source = fixture(100, 100, (x, y) => x >= 26 && x < 29 && y >= 30 && y < 33 ? [250, 246, 240, 255] : [35, 80, 90, 255]);
    const highlights = sourceEyeHighlights(source, face.points);
    expect(highlights).toHaveLength(1); expect(highlights[0].position[0]).toBeCloseTo(.275, 3); expect(highlights[0].color).toEqual([250, 246, 240]);
    expect(sourceEyeHighlights(fixture(100, 100, () => [250, 246, 240, 255]), face.points)).toEqual([]);
  });
  it('recovers from a neural failure with the complete geometric result and an honest status', async () => {
    const source = fixture(96, 72, (x, y) => [x * 2, y * 2, 100, 255]), analyze = vi.fn(async () => { throw new Error('Model unavailable'); });
    const result = await pixelateAccelerated(source, { ...settings, semanticDetail: 75 }, undefined, undefined, analyze);
    expect(analyze).toHaveBeenCalledOnce(); expect(result.execution.semantic?.backend).toBe('none'); expect(result.execution.semantic?.reason).toContain('Model unavailable');
    expect(result.data).toEqual(pixelate(source, settings).data);
  });
});
