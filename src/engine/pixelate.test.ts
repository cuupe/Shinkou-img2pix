import { describe, expect, it } from 'vitest';
import { dimensions, pixelate } from './pixelate';
import { PALETTES } from './palettes';
import { DEFAULT_SETTINGS } from './types';
import type { PixelSource, Settings } from './types';

const settings: Settings = { ...DEFAULT_SETTINGS, method: 'sample', size: 16, colors: 256, brightness: 0, contrast: 0, saturation: 0, detail: false };
function fixture(width: number, height: number, color: (x: number, y: number) => number[]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data };
}
describe('pixel pipeline', () => {
  it('preserves portrait and landscape proportions without upsampling', () => {
    expect(dimensions(4000, 3000, 160)).toEqual({ width: 160, height: 120 });
    expect(dimensions(3000, 4000, 160)).toEqual({ width: 120, height: 160 });
    expect(dimensions(8, 4, 160)).toEqual({ width: 8, height: 4 });
    expect(dimensions(1, 10000, 16)).toEqual({ width: 1, height: 16 });
  });
  it('averages light in linear space rather than darkening high frequency detail', () => {
    const source = fixture(32, 16, x => x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const out = pixelate(source, settings);
    expect(out.width).toBe(16); expect(out.height).toBe(8);
    expect(out.data[0]).toBeGreaterThanOrEqual(186); expect(out.data[0]).toBeLessThanOrEqual(189);
  });
  it('ignores RGB from invisible pixels and does not add dark alpha fringes', () => {
    const source = fixture(32, 16, x => x % 2 ? [255, 0, 0, 0] : [255, 255, 255, 255]);
    const out = pixelate(source, settings);
    expect([...out.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(out.palette).toEqual([[255, 255, 255]]);
  });
  it('handles fully transparent images and white matte correctly', () => {
    const source = fixture(16, 16, () => [240, 0, 100, 0]);
    const transparent = pixelate(source, settings);
    expect(transparent.palette).toEqual([]); expect(transparent.data.every(v => v === 0)).toBe(true);
    const matte = pixelate(source, { ...settings, transparent: false });
    expect([...matte.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });
  const gradient = fixture(64, 32, (x, y) => [x * 4, y * 8, (x + y) * 2, x < 2 ? 0 : 255]);
  for (const dither of ['none', 'ordered', 'floyd'] as const) {
    it(`respects fixed palette and binary alpha with ${dither} dithering`, () => {
      const out = pixelate(gradient, { ...settings, size: 64, palette: 'pico8', dither });
      const allowed = new Set(PALETTES.pico8.map(c => c.join(',')));
      for (let i = 0; i < out.data.length; i += 4) {
        expect([0, 255]).toContain(out.data[i + 3]);
        if (out.data[i + 3]) expect(allowed.has([...out.data.slice(i, i + 3)].join(','))).toBe(true);
      }
      expect(out.data).toEqual(pixelate(gradient, { ...settings, size: 64, palette: 'pico8', dither }).data);
    });
  }
  it('keeps the adaptive color budget and leaves the source untouched', () => {
    const before = gradient.data.slice();
    const out = pixelate(gradient, { ...settings, colors: 8 });
    expect(out.palette.length).toBeLessThanOrEqual(8);
    expect(new Set(Array.from({ length: out.width * out.height }, (_, p) => out.data[p * 4 + 3] ? [...out.data.slice(p * 4, p * 4 + 3)].join(',') : 'alpha')).size).toBeLessThanOrEqual(9);
    expect(gradient.data).toEqual(before);
  });
  it('rejects malformed source data', () => {
    expect(() => pixelate({ width: 4, height: 4, data: new Uint8ClampedArray(3) }, settings)).toThrow();
  });
});
