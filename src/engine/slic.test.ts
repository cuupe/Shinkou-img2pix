import { describe, expect, it } from 'vitest';
import { cleanSuperpixels, segmentSlic } from './slic';
import { detectFeatures } from './structure';
import { pixelate } from './pixelate';
import { DEFAULT_SETTINGS } from './types';
import type { RGB } from './types';
const palette: RGB[] = [[148, 152, 156], [155, 159, 163], [0, 0, 0]];
function fixture() {
  const data = new Uint8ClampedArray(48 * 32 * 4);
  for (let p = 0; p < 48 * 32; p++) data.set([...palette[p % 23 === 0 ? 1 : 0], 255], p * 4);
  return data;
}

describe('SLIC region cleanup', () => {
  it('reduces low-contrast flecks using only existing palette colors', () => {
    const original = fixture(), out = original.slice(), features = detectFeatures(original, 48, 32);
    const count = cleanSuperpixels(original, out, 48, 32, palette, features, 100, 8);
    expect(count).toBeGreaterThan(40);
    const allowed = new Set(palette.map(c => c.join(',')));
    for (let p = 0; p < 48 * 32; p++) expect(allowed.has(Array.from(out.slice(p * 4, p * 4 + 3)).join(','))).toBe(true);
    expect(original).toEqual(fixture());
  });
  it('leaves the image identical when disabled', () => {
    const original = fixture(), out = original.slice();
    expect(cleanSuperpixels(original, out, 48, 32, palette, detectFeatures(original, 48, 32), 0, 8)).toBe(0);
    expect(out).toEqual(original);
  });
  it('preserves protected minority details, dark one-pixel lines and transparency', () => {
    const original = fixture();
    for (let y = 0; y < 32; y++) original.set([0, 0, 0, 255], (y * 48 + 24) * 4);
    original.set([19, 20, 21, 0], 48 * 4);
    const features = detectFeatures(original, 48, 32), out = original.slice(); features.importance[23] = 1;
    cleanSuperpixels(original, out, 48, 32, palette, features, 100, 8);
    expect(Array.from(out.slice(23 * 4, 24 * 4))).toEqual([...palette[1], 255]);
    for (let y = 0; y < 32; y++) expect(Array.from(out.slice((y * 48 + 24) * 4, (y * 48 + 25) * 4))).toEqual([0, 0, 0, 255]);
    expect(out.slice(48 * 4, 49 * 4)).toEqual(original.slice(48 * 4, 49 * 4));
  });
  it('assigns every opaque pixel, including isolated pixels in empty seed tiles', () => {
    const data = new Uint8ClampedArray(19 * 15 * 4);
    for (const p of [0, 7, 18, 19 * 14, 19 * 15 - 1, 19 * 6 + 8]) data.set([255, 0, 0, 255], p * 4);
    const labels = segmentSlic(data, 19, 15, { spacing: 6 });
    for (let p = 0; p < labels.length; p++) expect(labels[p] >= 0).toBe(data[p * 4 + 3] > 0);
  });
  it('returns four-connected components with distinct labels across an alpha gap', () => {
    const data = fixture(); for (let y = 0; y < 32; y++) data[(y * 48 + 24) * 4 + 3] = 0;
    const labels = segmentSlic(data, 48, 32, { spacing: 8 }), reached = new Set<number>(), visited = new Set<number>();
    for (let p = 0; p < labels.length; p++) {
      if (labels[p] < 0 || visited.has(p)) continue;
      expect(reached.has(labels[p])).toBe(false); reached.add(labels[p]);
      const queue = [p]; visited.add(p);
      while (queue.length) {
        const q = queue.pop()!, x = q % 48;
        for (const r of [x > 0 ? q - 1 : -1, x < 47 ? q + 1 : -1, q - 48, q + 48]) {
          if (r < 0 || r >= labels.length || visited.has(r) || labels[r] !== labels[p]) continue;
          visited.add(r); queue.push(r);
        }
      }
    }
  });
  it('is deterministic and integrates without changing dimensions, alpha or color budget', () => {
    const source = { data: fixture(), width: 48, height: 32 }, settings = { ...DEFAULT_SETTINGS, size: 32, colors: 8, regionCleanup: 70 };
    const a = pixelate(source, settings), b = pixelate(source, settings);
    expect(a.data).toEqual(b.data); expect([a.width, a.height]).toEqual([32, 21]); expect(a.palette.length).toBeLessThanOrEqual(8);
    for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255);
    expect(a.execution.timings.regions).toBeGreaterThanOrEqual(0);
  });
});
