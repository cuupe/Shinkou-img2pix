import { describe, expect, it } from 'vitest';
import { resolveTransitions } from './transitions';
import { detectFeatures } from './structure';
import { pixelate } from './pixelate';
import { DEFAULT_SETTINGS } from './types';
import type { RGB } from './types';

const colors: RGB[] = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [240, 40, 60]];
function strip() {
  const width = 15, height = 9, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...colors[x === 7 ? 2 : x < 7 ? 0 : 1], 255], (y * width + x) * 4);
  return { data, width, height };
}
describe('transition retention', () => {
  it('removes a neutral edge mixture at zero and keeps the quantized data at 100', () => {
    const source = strip(), features = detectFeatures(source.data, source.width, source.height);
    const clean = source.data.slice(), retained = source.data.slice();
    resolveTransitions(source.data, clean, source.width, source.height, colors, features, 0);
    resolveTransitions(source.data, retained, source.width, source.height, colors, features, 100);
    expect([...clean.slice((4 * source.width + 7) * 4, (4 * source.width + 7) * 4 + 3)]).not.toEqual(colors[2]);
    expect(retained).toEqual(source.data);
  });
  it('retains more intermediate colors as the setting increases, deterministically', () => {
    const source = strip(), features = detectFeatures(source.data, source.width, source.height);
    const counts: number[] = [];
    for (const retention of [0, 25, 50, 75, 100]) {
      const data = source.data.slice(), again = source.data.slice();
      resolveTransitions(source.data, data, source.width, source.height, colors, features, retention);
      resolveTransitions(source.data, again, source.width, source.height, colors, features, retention);
      counts.push(Array.from({ length: source.width * source.height }, (_, p) => data[p * 4] === 128 ? 1 : 0).reduce<number>((a, b) => a + b, 0));
      expect(data).toEqual(again);
    }
    expect(counts[0]).toBeLessThan(counts[4]);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });
  it('keeps a real third-color stripe and the source buffer unchanged at maximum suppression', () => {
    const source = strip();
    for (let y = 0; y < source.height; y++) source.data.set([...colors[3], 255], (y * source.width + 7) * 4);
    const before = source.data.slice(), data = source.data.slice();
    resolveTransitions(source.data, data, source.width, source.height, colors, detectFeatures(source.data, source.width, source.height), 0);
    expect(data).toEqual(before); expect(source.data).toEqual(before);
  });
  it('preserves the center of a wide gray region instead of treating all gray as antialiasing', () => {
    const width = 23, height = 9, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...colors[x < 5 ? 0 : x > 17 ? 1 : 2], 255], (y * width + x) * 4);
    const out = data.slice(); resolveTransitions(data, out, width, height, colors, detectFeatures(data, width, height), 0);
    expect([...out.slice((4 * width + 11) * 4, (4 * width + 11) * 4 + 3)]).toEqual(colors[2]);
  });
  it('preserves alpha and uses only palette colors at all retention levels', () => {
    const source = strip(); source.data.fill(0, 0, source.width * 4);
    for (const transitionRetention of [0, 25, 100]) {
      const out = pixelate(source, { ...DEFAULT_SETTINGS, size: 32, colors: 8, transitionRetention });
      const allowed = new Set(out.palette.map(c => c.join(',')));
      for (let p = 0; p < out.width * out.height; p++) {
        expect([0, 255]).toContain(out.data[p * 4 + 3]);
        if (out.data[p * 4 + 3]) expect(allowed.has([...out.data.slice(p * 4, p * 4 + 3)].join(','))).toBe(true);
      }
      expect(out.data[3]).toBe(0);
    }
  });
  it('uses observed analysis colors at zero when no analysis resize is needed', () => {
    const width = 16, height = 16, data = new Uint8ClampedArray(width * height * 4);
    const input: RGB[] = [[20, 30, 40], [180, 70, 90], [240, 230, 210]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...input[Math.min(2, Math.floor(x / 6))], 255], (y * width + x) * 4);
    const out = pixelate({ data, width, height }, { ...DEFAULT_SETTINGS, size: 32, colors: 2, transitionRetention: 0 });
    for (const c of out.palette) expect(input).toContainEqual(c);
  });
  it('does not apply the new control to the photograph sampling path', () => {
    const source = strip();
    const out = pixelate(source, { ...DEFAULT_SETTINGS, method: 'sample', transitionRetention: 0 });
    expect(out.data).toEqual(pixelate(source, { ...DEFAULT_SETTINGS, method: 'sample', transitionRetention: 100 }).data);
  });
  it('recognizes a colored transition created by linear-light area sampling', () => {
    const a: RGB = [20, 70, 130], b: RGB = [240, 215, 170];
    const linear = (v: number) => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4;
    const encode = (v: number) => Math.round(255 * (v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055));
    const mix = a.map((v, k) => encode(linear(v) * .6 + linear(b[k]) * .4)) as RGB;
    const source = strip(), palette: RGB[] = [a, b, mix];
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) source.data.set([...palette[x === 7 ? 2 : x < 7 ? 0 : 1], 255], (y * source.width + x) * 4);
    const out = source.data.slice(); resolveTransitions(source.data, out, source.width, source.height, palette, detectFeatures(source.data, source.width, source.height), 0);
    expect([a, b]).toContainEqual([...out.slice((4 * source.width + 7) * 4, (4 * source.width + 7) * 4 + 3)]);
  });
});
