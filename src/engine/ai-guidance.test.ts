import { describe, expect, it } from 'vitest';
import { applyAiGuidance, edgePreview, teedInput } from './ai-guidance';
import { detectFeatures } from './structure';
import { pixelateAccelerated } from './backend';
import { pixelate } from './pixelate';
import { DEFAULT_SETTINGS } from './types';
const map = { data: new Float32Array(16).fill(1), width: 4, height: 4, contentWidth: 4, contentHeight: 4 };
function fixture(line = false) {
  const data = new Uint8ClampedArray(15 * 15 * 4);
  for (let p = 0; p < 225; p++) { const color = line && p % 15 === 7 ? 185 : 200; data.set([color, color, color, 255], p * 4); }
  return { data, width: 15, height: 15 };
}
describe('neural guidance contracts', () => {
  it('uses training-compatible byte-scale BGR planar input', () => {
    const input = teedInput(new Uint8ClampedArray([255, 12, 32, 255, 17, 50, 99, 255]));
    expect(input[0]).toBeCloseTo(32 - 103.939, 4); expect(input[1]).toBeCloseTo(99 - 103.939, 4);
    expect(input[2]).toBeCloseTo(12 - 116.779, 4); expect(input[4]).toBeCloseTo(255 - 123.68, 4);
  });
  it('cannot invent ridges in flat colors even with maximum neural response', () => {
    const image = fixture(), features = detectFeatures(image.data, 15, 15);
    applyAiGuidance(image, features, map, 100); expect([...features.importance].every(v => v === 0)).toBe(true);
  });
  it('boosts source-supported faint lines without editing RGB or alpha', () => {
    const image = fixture(true), original = image.data.slice(), features = detectFeatures(image.data, 15, 15), p = 7 * 15 + 7, before = features.importance[p];
    applyAiGuidance(image, features, map, 100);
    expect(features.importance[p]).toBeGreaterThan(before); expect(features.importance[p]).toBeGreaterThan(.4);
    expect(image.data).toEqual(original);
  });
  it('keeps disabled guidance and transparent pixels unchanged', () => {
    const image = fixture(true); image.data[(7 * 15 + 7) * 4 + 3] = 0;
    const features = detectFeatures(image.data, 15, 15), before = features.importance.slice();
    applyAiGuidance(image, features, map, 0); expect(features.importance).toEqual(before);
    applyAiGuidance(image, features, map, 100); expect(features.importance[7 * 15 + 7]).toBe(before[7 * 15 + 7]);
  });
  it('crops padded model output for visualization', () => {
    const preview = edgePreview({ data: new Float32Array([0, 1, 1, 0]), width: 2, height: 2, contentWidth: 1, contentHeight: 2 });
    expect([preview.width, preview.height]).toEqual([1, 2]); expect(Array.from(preview.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
  it('reports failed inference while preserving the exact base image', async () => {
    const source = fixture(true), settings = { ...DEFAULT_SETTINGS, backend: 'cpu' as const, aiStrength: 75 };
    const actual = await pixelateAccelerated(source, settings, undefined, async () => { throw new Error('Missing model'); });
    expect(actual.data).toEqual(pixelate(source, { ...settings, aiStrength: 0 }).data);
    expect(actual.execution.ai?.backend).toBe('none'); expect(actual.execution.ai?.reason).toContain('Missing model');
  });
  it('uses CPU inference when requested and keeps the extracted palette identical', async () => {
    const source = fixture(true), settings = { ...DEFAULT_SETTINGS, backend: 'cpu' as const, aiStrength: 75 };
    let cpuFlag: boolean | undefined;
    const result = await pixelateAccelerated(source, settings, undefined, async (_source, cpu) => {
      cpuFlag = cpu; return { map, info: { model: 'fixture', backend: 'wasm', duration: 1, cached: false } };
    });
    expect(cpuFlag).toBe(true); expect(result.palette).toEqual(pixelate(source, { ...settings, aiStrength: 0 }).palette);
    expect(result.execution.ai?.backend).toBe('wasm');
  });
});
