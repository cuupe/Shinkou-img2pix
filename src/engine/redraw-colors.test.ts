import { describe, expect, it } from 'vitest';
import { prepareRedrawColors } from './redraw-colors';
import { normalizeRedraw } from './redraw';
import { oklab } from './pixelate';
import type { PixelSource, RGB } from './types';

const original = { bg: [222, 211, 207], hair: [236, 133, 155], skin: [250, 212, 189], ink: [58, 34, 52], blue: [59, 161, 182] } as const;
function portrait(generated = false): PixelSource {
  const w = 64, data = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    let rgb: readonly number[] = generated ? [255, 255, 255] : original.bg;
    if (x >= 8 && x < 56 && y >= 8 && y < 58) rgb = generated ? [182, 0, 39] : original.hair;
    if (x >= 16 && x < 48 && y >= 24 && y < 54) rgb = generated ? [255, 224, 151] : original.skin;
    if (y >= 28 && y <= 32 && ((x >= 20 && x <= 24) || (x >= 40 && x <= 44))) rgb = [255, 255, 255];
    if ((x === 22 || x === 42) && y >= 29 && y <= 31) rgb = generated ? [0, 100, 255] : original.blue;
    if (y === 27 && ((x >= 19 && x <= 25) || (x >= 39 && x <= 45))) rgb = generated ? [0, 0, 0] : original.ink;
    data.set([...rgb, 255], (y * w + x) * 4);
  }
  return { width: w, height: w, data };
}
const options = { size: 32, colors: 16, palette: 'adaptive' as const, phaseX: 0, phaseY: 0 };
const pixel = (source: PixelSource, x: number, y: number) => [...source.data.slice((y * source.width + x) * 4, (y * source.width + x) * 4 + 3)] as RGB;
const error = (a: RGB, b: RGB) => { const aa = oklab(a), bb = oklab(b); return aa.reduce((sum, c, k) => sum + (c - bb[k]) ** 2, 0); };

describe('redraw original-color constraints', () => {
  it('corrects a large saturated red region instead of mapping it all to scarce dark ink', () => {
    const source = portrait(), generated = portrait(true), reference = prepareRedrawColors(source, 16);
    const before = normalizeRedraw(generated, options), after = normalizeRedraw(generated, { ...options, sourceColors: reference, colorRetention: 100 });
    const pink = [...original.hair] as RGB;
    expect(error(pixel(after, 16, 8), pink)).toBeLessThan(error(pixel(before, 16, 8), pink) * .25);
    expect(pixel(after, 16, 8)[1]).toBeGreaterThan(90);
  });
  it('keeps interior eye whites separate from a same-colored generated background', () => {
    const reference = prepareRedrawColors(portrait(), 16);
    const result = normalizeRedraw(portrait(true), { ...options, sourceColors: reference });
    expect(pixel(result, 0, 0)).toEqual([...original.bg]);
    expect(pixel(result, 10, 14)).toEqual([255, 255, 255]);
    expect(pixel(result, 10, 13).reduce((sum, c) => sum + c, 0)).toBeLessThan(220);
  });
  it('100% produces only original palette entries without moving cells or changing alpha', () => {
    const generated = portrait(true), saved = generated.data.slice(), reference = prepareRedrawColors(portrait(), 16);
    const result = normalizeRedraw(generated, { ...options, sourceColors: reference, colorRetention: 100 });
    const allowed = new Set(reference.palette.map(c => c.join(',')));
    expect([result.width, result.height]).toEqual([32, 32]); expect(generated.data).toEqual(saved);
    for (let i = 0; i < result.data.length; i += 4) { expect(allowed.has([...result.data.slice(i, i + 3)].join(','))).toBe(true); expect(result.data[i + 3]).toBe(255); }
  });
  it('0% exactly retains the previous output, including its palette', () => {
    const generated = portrait(true), reference = prepareRedrawColors(portrait(), 16);
    const old = normalizeRedraw(generated, options), disabled = normalizeRedraw(generated, { ...options, sourceColors: reference, colorRetention: 0 });
    expect(disabled.data).toEqual(old.data); expect(disabled.palette).toEqual(old.palette);
  });
  it('all intermediate strengths obey the selected color budget', () => {
    for (const colors of [4, 8, 16]) {
      const reference = prepareRedrawColors(portrait(), colors);
      for (const colorRetention of [1, 25, 50, 75, 100]) {
        const result = normalizeRedraw(portrait(true), { ...options, colors, sourceColors: reference, colorRetention });
        expect(result.palette.length).toBeLessThanOrEqual(colors);
      }
    }
  });
  it('does not override a deliberately selected fixed style palette', () => {
    const reference = prepareRedrawColors(portrait(), 16), fixed = { ...options, palette: 'pico8' as const };
    expect(normalizeRedraw(portrait(true), { ...fixed, sourceColors: reference, colorRetention: 100 }).data).toEqual(normalizeRedraw(portrait(true), fixed).data);
  });
  it('ignores hidden RGB when preparing a transparent original, and preserves transparent output', () => {
    const source = portrait(); source.data.fill(0); for (let i = 0; i < source.data.length; i += 4) source.data.set([0, 255, 0, 0], i);
    const reference = prepareRedrawColors(source, 16);
    expect(reference.palette).toEqual([[255, 255, 255]]);
    const result = normalizeRedraw(source, { ...options, sourceColors: reference });
    expect(result.palette).toEqual([]); expect(result.data.every(c => c === 0)).toBe(true);
  });
});
