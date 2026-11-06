import { dimensions, pixelate } from './pixelate';
import { DEFAULT_SETTINGS } from './types';
import type { PaletteId, PixelResult, PixelSource } from './types';
import { retainRedrawColors } from './redraw-colors';
import type { RedrawColorReference } from './redraw-colors';

export interface RedrawGrid { size: number; colors: number; palette: PaletteId; phaseX: number; phaseY: number; target?: { width: number; height: number }; sourceColors?: RedrawColorReference; colorRetention?: number }
export type RedrawProfile = 'compact' | 'faithful';

/** Generation owns the semantic layout. This stage chooses grid samples, bounds
 * the palette and optionally restores source colors without adding source lines. */
export function normalizeRedraw(source: PixelSource, options: RedrawGrid): PixelResult {
  if (!source.width || !source.height || source.data.length !== source.width * source.height * 4) throw new Error('候选图像数据无效');
  const size = Math.max(16, Math.min(64, Math.round(options.size)));
  const { width, height } = options.target ?? dimensions(source.width, source.height, size);
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 64)) throw new Error('候选网格尺寸无效');
  const data = new Uint8ClampedArray(width * height * 4);
  const phase = (value: number) => Math.max(-0.45, Math.min(0.45, Number.isFinite(value) ? value : 0));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(source.width - 1, Math.floor((x + 0.5 + phase(options.phaseX)) * source.width / width));
    const sy = Math.min(source.height - 1, Math.floor((y + 0.5 + phase(options.phaseY)) * source.height / height));
    data.set(source.data.subarray((sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4), (y * width + x) * 4);
  }
  const result = pixelate({ width, height, data }, {
    ...DEFAULT_SETTINGS, backend: 'cpu', method: 'sample', size, colors: options.colors, palette: options.palette,
    detail: false, dither: 'none', transitionRetention: 100,
  });
  return options.palette === 'adaptive' && options.sourceColors ? retainRedrawColors(result, options.sourceColors, options.colorRetention ?? 100, options.colors) : result;
}

export function redrawPrompt(width: number, height: number, colors: number, instruction: string) {
  return `pixel art sprite, game portrait. Reimagine the reference for a ${width} by ${height} pixel grid. Preserve the same character identity, pose, composition, hairstyle, clothing, distinctive accessories and original eye colors. Redesign the details to fit this very small grid, rather than simply tracing all the original lines. Use a few large connected color clusters and approximately ${colors} colors. Preserve the restrained colors of the reference. Keep readable eyes and a small clearly visible mouth when present; preserve the original expression. Simplify hair or fur into a few broad shapes. Use selective colored contours only where needed, omit lines that would crowd the face. No unnecessary pure black outlines, no tiny scattered marks, no elaborate shading, no gradient, no antialiasing, no text, no drawn grid, no borders. Keep the reference aspect ratio. ${instruction.trim()}`;
}

export function generationDimensions(width: number, height: number, longEdge = 512) {
  const ratio = width / height;
  if (ratio < 0.25 || ratio > 4) throw new Error('AI 重绘暂支持宽高比在 1:4 到 4:1 之间的图片');
  const minimum = longEdge >= 512 ? 128 : 64;
  const scale = Math.max(longEdge / Math.max(width, height), minimum / Math.min(width, height));
  return { width: Math.max(minimum, Math.round(width * scale / 16) * 16), height: Math.max(minimum, Math.round(height * scale / 16) * 16) };
}

export function redrawDimensions(width: number, height: number, size: number, profile: RedrawProfile) {
  return generationDimensions(width, height, profile === 'faithful' ? 512 : Math.max(64, Math.min(256, size * 4)));
}
