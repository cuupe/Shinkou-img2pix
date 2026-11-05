import { describe, expect, it } from 'vitest';
import { samplePixel, samplePixelAtPoint } from './pixel-picker';
const image = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 19, 20, 21, 0]) };
describe('result grid sampling', () => {
  it('maps non-integer CSS scales and panned coordinates to the exact cell', () => {
    expect(samplePixelAtPoint(image, { left: -13.5, top: 28.2, width: 71.3, height: 53.1 }, 30, 40)?.color).toEqual([0, 255, 0]);
  });
  it('includes the top-left boundary and rejects right/bottom and outside points', () => {
    const rect = { left: 10, top: 20, width: 40, height: 40 };
    expect(samplePixelAtPoint(image, rect, 10, 20)?.color).toEqual([255, 0, 0]);
    for (const [x, y] of [[50, 21], [11, 60], [9, 21], [11, 19]]) expect(samplePixelAtPoint(image, rect, x, y)).toBeUndefined();
  });
  it('reports transparency without turning it into opaque black', () => {
    expect(samplePixel(image, 1, 1)).toEqual({ x: 1, y: 1, color: [19, 20, 21], alpha: 0 });
    expect(samplePixel(image, .5, 0)).toBeUndefined();
    expect(samplePixelAtPoint(image, { left: 0, top: 0, width: 0, height: 40 }, 0, 0)).toBeUndefined();
  });
});
