import { describe, expect, it } from 'vitest';
import { generationDimensions, normalizeRedraw, redrawDimensions, redrawPrompt } from './redraw';
import { PALETTES } from './palettes';
import type { PixelSource } from './types';

const grid = { size: 32, colors: 4, palette: 'adaptive' as const, phaseX: 0, phaseY: 0 };
function enlarged(): PixelSource {
  const data = new Uint8ClampedArray(128 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) data.set(x % 8 < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 128 + x) * 4);
  return { width: 128, height: 64, data };
}
describe('generated candidate grid', () => {
  it('recovers exact source colors on an aligned enlarged grid without averaging or outlining', () => {
    const result = normalizeRedraw(enlarged(), grid);
    expect([result.width, result.height]).toEqual([32, 16]);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) expect([...result.data.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]).toEqual(x % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
  });
  it('allows cell phase correction without changing the true grid or palette budget', () => {
    const source = enlarged();
    for (let y = 0; y < 64; y++) source.data.set([0, 255, 0, 255], (y * 128 + 1) * 4);
    const centered = normalizeRedraw(source, grid), shifted = normalizeRedraw(source, { ...grid, phaseX: -0.25 });
    expect([...centered.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...shifted.data.slice(0, 4)]).toEqual([0, 255, 0, 255]);
    expect(shifted.palette.length).toBeLessThanOrEqual(grid.colors);
  });
  it('uses only the selected fixed palette and keeps alpha binary', () => {
    const source = enlarged(); source.data.fill(0, 0, 4 * 128 * 4);
    const result = normalizeRedraw(source, { ...grid, palette: 'gameboy' });
    for (let i = 0; i < result.data.length; i += 4) {
      expect([0, 255]).toContain(result.data[i + 3]);
      if (result.data[i + 3]) expect(PALETTES.gameboy).toContainEqual([...result.data.slice(i, i + 3)]);
    }
  });
  it('rejects corrupt source data', () => {
    expect(() => normalizeRedraw({ width: 3, height: 3, data: new Uint8ClampedArray(0) }, grid)).toThrow();
  });
  it('keeps the source target aspect when model dimensions were rounded to latent multiples', () => {
    const result = normalizeRedraw(enlarged(), { ...grid, size: 48, target: { width: 48, height: 25 } });
    expect([result.width, result.height]).toEqual([48, 25]);
    expect(() => normalizeRedraw(enlarged(), { ...grid, target: { width: 500, height: 25 } })).toThrow();
  });
  it('uses aligned low-memory generation dimensions and refuses extreme aspect ratios', () => {
    expect(generationDimensions(1200, 900)).toEqual({ width: 512, height: 384 });
    expect(generationDimensions(400, 1600)).toEqual({ width: 128, height: 512 });
    expect(() => generationDimensions(8, 1000)).toThrow();
  });
  it('keeps compact generation distinct from the 512px source reference', () => {
    expect(redrawDimensions(1200, 1200, 32, 'compact')).toEqual({ width: 128, height: 128 });
    expect(redrawDimensions(1200, 1200, 16, 'compact')).toEqual({ width: 64, height: 64 });
    expect(redrawDimensions(1200, 900, 32, 'compact')).toEqual({ width: 128, height: 96 });
    expect(redrawDimensions(1200, 1200, 32, 'faithful')).toEqual({ width: 512, height: 512 });
  });
  it('asks for semantic redraw at the actual target dimensions, with selective contours', () => {
    const prompt = redrawPrompt(32, 24, 16, 'Keep the blue eyes.');
    expect(prompt).toContain('32 by 24'); expect(prompt).toContain('16 colors');
    expect(prompt).toContain('selective colored contours'); expect(prompt).toContain('Keep the blue eyes.');
  });
});
