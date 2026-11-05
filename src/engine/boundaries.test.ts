import { describe, expect, it } from 'vitest';
import { regularizeBoundaries } from './boundaries';
import { detectFeatures } from './structure';
import { resolveTransitions } from './transitions';
import { pixelate } from './pixelate';
import { DEFAULT_SETTINGS } from './types';
import type { StructureResult } from './structure';
import type { RGB } from './types';

const palette: RGB[] = [[250, 250, 250], [0, 0, 0]];
function mapped(width: number, height: number, label: (x: number, y: number) => number): StructureResult {
  const labels = new Int16Array(width * height), data = new Uint8ClampedArray(labels.length * 4);
  const candidates = new Int16Array(labels.length * 4).fill(-1), scores = new Float32Array(labels.length * 4).fill(-Infinity);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x; labels[p] = label(x, y); candidates[p * 4] = labels[p]; scores[p * 4] = 1;
    data.set([...palette[labels[p]], 255], p * 4);
  }
  return { labels, data, candidates, scores, protected: new Float32Array(labels.length), coverage: new Float32Array(labels.length).fill(1) };
}
function ambiguous(r: StructureResult, p: number) {
  r.scores![p * 4] = .6; r.scores![p * 4 + 1] = .5; r.candidates![p * 4 + 1] = 1 - r.labels[p];
}
describe('contour regularization', () => {
  it('removes an ambiguous spur without changing strongly supported region pixels', () => {
    const r = mapped(9, 9, (x, y) => (x >= 2 && x <= 5 && y >= 2 && y <= 6) || (x === 6 && y === 3) ? 1 : 0);
    ambiguous(r, 3 * 9 + 6); regularizeBoundaries(r, 9, 9, palette, 100);
    expect(r.labels[3 * 9 + 6]).toBe(0); expect(r.labels[3 * 9 + 5]).toBe(1);
  });
  it('keeps a one-cell bridge connecting two regions', () => {
    const r = mapped(9, 9, (x, y) => y === 4 && x >= 2 && x <= 6 ? 1 : 0);
    ambiguous(r, 4 * 9 + 4); regularizeBoundaries(r, 9, 9, palette, 100);
    expect(r.labels[4 * 9 + 4]).toBe(1);
  });
  it('does not erase a protected highlight or expand into transparent space', () => {
    const r = mapped(9, 9, (x, y) => x === 4 && y === 4 ? 1 : 0);
    ambiguous(r, 40); r.protected[40] = 1; r.labels[39] = -1; r.data.fill(0, 39 * 4, 40 * 4);
    regularizeBoundaries(r, 9, 9, palette, 100);
    expect(r.labels[40]).toBe(1); expect(r.labels[39]).toBe(-1); expect(r.data[39 * 4 + 3]).toBe(0);
  });
  it('leaves source decisions unchanged when contour regularity is zero', () => {
    const r = mapped(9, 9, (x, y) => x === 4 || y === 4 ? 1 : 0), before = r.labels.slice();
    ambiguous(r, 41); regularizeBoundaries(r, 9, 9, palette, 0); expect(r.labels).toEqual(before);
  });
});
describe('local transition colors', () => {
  it('maps a black/white mixture to local ink/paper instead of an unrelated palette green', () => {
    const width = 15, height = 9, original = new Uint8ClampedArray(width * height * 4), quantized = new Uint8ClampedArray(original.length);
    const colors: RGB[] = [[0, 0, 0], [255, 255, 255], [30, 150, 150]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      original.set([...(x === 7 ? [128, 128, 128] : x < 7 ? colors[0] : colors[1]), 255], p);
      quantized.set([...colors[x === 7 ? 2 : x < 7 ? 0 : 1], 255], p);
    }
    resolveTransitions(original, quantized, width, height, colors, detectFeatures(original, width, height));
    for (let y = 0; y < height; y++) expect([[0, 0, 0], [255, 255, 255]]).toContainEqual([...quantized.slice((y * width + 7) * 4, (y * width + 7) * 4 + 3)]);
  });
  it('keeps a genuine third-color region and does not alter the original buffer', () => {
    const width = 15, height = 9, original = new Uint8ClampedArray(width * height * 4), colors: RGB[] = [[0, 0, 0], [255, 255, 255], [240, 40, 60]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) original.set([...colors[x >= 6 && x <= 8 ? 2 : x < 6 ? 0 : 1], 255], (y * width + x) * 4);
    const before = original.slice(), quantized = original.slice();
    resolveTransitions(original, quantized, width, height, colors, detectFeatures(original, width, height));
    expect(quantized).toEqual(before); expect(original).toEqual(before);
  });
  it('preserves actual black and white in an adaptive palette beside a large mint background', () => {
    const width = 128, height = 96, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = x > 40 && x < 86 && y > 25 && y < 75, highlight = inside && x > 52 && x < 60 && y > 38 && y < 46;
      data.set([...(highlight ? [255, 255, 255] : inside ? [0, 0, 0] : [170, 225, 220]), 255], (y * width + x) * 4);
    }
    const out = pixelate({ data, width, height }, { ...DEFAULT_SETTINGS, size: 64, colors: 8 });
    expect(out.palette).toContainEqual([0, 0, 0]); expect(out.palette).toContainEqual([255, 255, 255]);
    const shown = new Set(Array.from({ length: out.width * out.height }, (_, p) => [...out.data.slice(p * 4, p * 4 + 3)].join(',')));
    expect(shown.has('255,255,255')).toBe(true); expect(shown.has('0,0,0')).toBe(true);
  });
});
