import type { PixelSource, RGB } from '../engine/types';

export interface PixelSample { x: number; y: number; color: RGB; alpha: number }
export function samplePixel(image: PixelSource, x: number, y: number): PixelSample | undefined {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = (y * image.width + x) * 4;
  return { x, y, color: [image.data[i], image.data[i + 1], image.data[i + 2]], alpha: image.data[i + 3] };
}

/** Map CSS coordinates to source cells; never read a scaled/overlaid canvas. */
export function samplePixelAtPoint(image: PixelSource, rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) {
  if (rect.width <= 0 || rect.height <= 0) return;
  return samplePixel(image, Math.floor((clientX - rect.left) / rect.width * image.width), Math.floor((clientY - rect.top) / rect.height * image.height));
}
