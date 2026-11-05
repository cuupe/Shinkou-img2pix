import { describe, expect, it } from 'vitest';
import { pixelate } from './pixelate';
import { cleanRegions, detectFeatures } from './structure';
import { DEFAULT_SETTINGS } from './types';
import type { PixelSource, RGB, Settings } from './types';

function fixture(w: number, h: number, pixel: (x: number, y: number) => number[]): PixelSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(pixel(x, y), (y * w + x) * 4);
  return { data, width: w, height: h };
}
const settings: Settings = { ...DEFAULT_SETTINGS, lowResolution: 'source', size: 32, colors: 8, brightness: 0, contrast: 0, saturation: 0, cleanup: 45 };
describe('structure-preserving conversion', () => {
  it('keeps a sub-cell dark line dark instead of averaging it into a pale border', () => {
    const source = fixture(256, 128, x => x >= 9 && x < 12 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const old = pixelate(source, { ...settings, method: 'sample', detail: false });
    const next = pixelate(source, settings);
    const position = (8 * 32 + 1) * 4;
    expect(old.data[position]).toBeGreaterThan(170);
    expect(next.data[position]).toBeLessThan(50);
    for (let y = 0; y < next.height; y++) expect(next.data[(y * next.width + 1) * 4]).toBeLessThan(50);
  });
  it('also protects bright lines on a dark region', () => {
    const source = fixture(256, 128, x => x >= 9 && x < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const next = pixelate(source, settings);
    expect(next.data[(8 * 32 + 1) * 4]).toBeGreaterThan(230);
  });
  it('changes minority-line selection when line protection is disabled', () => {
    const source = fixture(256, 128, x => x >= 9 && x < 12 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
    const high = pixelate(source, settings), low = pixelate(source, { ...settings, lineProtection: 0 });
    expect(high.data[(8 * 32 + 1) * 4]).toBeLessThan(low.data[(8 * 32 + 1) * 4]);
  });
  it('does not shift a uniform color and produces no edge response on a flat fill', () => {
    const source = fixture(81, 63, () => [220, 130, 160, 255]);
    const features = detectFeatures(source.data, source.width, source.height);
    expect(features.importance.every(v => v === 0)).toBe(true);
    const next = pixelate(source, settings);
    for (let p = 0; p < next.width * next.height; p++) expect([...next.data.slice(p * 4, p * 4 + 4)]).toEqual([220, 130, 160, 255]);
  });
  it('keeps exact color-budget and binary-alpha constraints with each palette', () => {
    const source = fixture(128, 96, (x, y) => x < 16 ? [255, 0, 0, 0] : [x * 2, y * 2, 150, 255]);
    for (const palette of ['adaptive', 'pico8', 'gameboy', 'dusk'] as const) {
      const next = pixelate(source, { ...settings, palette });
      const allowed = new Set(next.palette.map(c => c.join(',')));
      if (palette === 'adaptive') expect(next.palette.length).toBeLessThanOrEqual(8);
      for (let i = 0; i < next.data.length; i += 4) {
        expect([0, 255]).toContain(next.data[i + 3]);
        if (next.data[i + 3]) expect(allowed.has([...next.data.slice(i, i + 3)].join(','))).toBe(true);
      }
    }
  });
  it('does not introduce dithering into building plans', () => {
    const source = fixture(96, 64, (x, y) => [x * 2, y * 3, 170, 255]);
    expect(pixelate(source, { ...settings, dither: 'none' }).data).toEqual(pixelate(source, { ...settings, dither: 'floyd' }).data);
  });
  it('merges a low-contrast speck, but preserves a thin chain and a protected highlight', () => {
    const width = 9, height = 9, palette: RGB[] = [[120, 120, 120], [140, 140, 140]];
    const labels = new Int16Array(width * height), protectedMap = new Float32Array(labels.length);
    labels[10] = 1; labels[40] = 1; protectedMap[40] = 1;
    labels[60] = labels[61] = labels[62] = 1;
    const data = new Uint8ClampedArray(labels.length * 4);
    labels.forEach((label, p) => data.set([...palette[label], 255], p * 4));
    const mapped = { data, labels, protected: protectedMap, coverage: new Float32Array(labels.length).fill(1) };
    cleanRegions(mapped, width, height, palette, 80);
    expect(mapped.labels[10]).toBe(0);
    expect(mapped.labels[40]).toBe(1);
    expect([...mapped.labels.slice(60, 63)]).toEqual([1, 1, 1]);
  });
  it('keeps transparent images transparent and leaves source data unchanged', () => {
    const source = fixture(64, 32, () => [255, 0, 0, 0]), before = source.data.slice();
    const next = pixelate(source, settings);
    expect(next.palette).toEqual([]); expect(next.data.every(v => v === 0)).toBe(true);
    expect(source.data).toEqual(before);
  });
});
