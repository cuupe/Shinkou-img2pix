import type { PixelSource, RGB, SemanticFace } from './types';

/** Measure compact white islands in the original eye ROI before grid sampling.
 * Sclera connected to the ROI boundary is excluded. At most one actual source
 * highlight per eye is retained; landmarks alone cannot create a highlight.
 */
export function sourceEyeHighlights(source: PixelSource, points: SemanticFace['points']): { position: [number, number]; color: RGB }[] {
  const found: { position: [number, number]; color: RGB }[] = [];
  for (const [first, end] of [[11, 17], [17, 23]]) {
    const eye = points.slice(first, end); if (eye.length !== 6 || eye.some(p => p[2] < .55)) continue;
    const x0 = Math.max(0, Math.floor(Math.min(...eye.map(p => p[0])) * source.width - 2)), x1 = Math.min(source.width, Math.ceil(Math.max(...eye.map(p => p[0])) * source.width + 2));
    const y0 = Math.max(0, Math.floor(Math.min(...eye.map(p => p[1])) * source.height - 2)), y1 = Math.min(source.height, Math.ceil(Math.max(...eye.map(p => p[1])) * source.height + 2));
    if (x1 <= x0 || y1 <= y0) continue;
    const seen = new Set<number>(); let best: { size: number; x: number; y: number; color: RGB } | undefined;
    const white = (p: number) => { const i = p * 4, r = source.data[i], g = source.data[i + 1], b = source.data[i + 2]; return source.data[i + 3] > 240 && Math.min(r, g, b) > 210 && Math.max(r, g, b) - Math.min(r, g, b) < 45; };
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const start = y * source.width + x; if (seen.has(start) || !white(start)) continue;
      const queue = [start]; seen.add(start); let sx = 0, sy = 0, edge = false; const rgb = [0, 0, 0];
      for (let head = 0; head < queue.length; head++) {
        const p = queue[head], xx = p % source.width, yy = Math.floor(p / source.width); sx += xx + .5; sy += yy + .5;
        for (let d = 0; d < 3; d++) rgb[d] += source.data[p * 4 + d];
        edge ||= xx === x0 || xx === x1 - 1 || yy === y0 || yy === y1 - 1;
        for (const [nx, ny] of [[xx - 1, yy], [xx + 1, yy], [xx, yy - 1], [xx, yy + 1]]) {
          const q = ny * source.width + nx; if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1 || seen.has(q) || !white(q)) continue;
          seen.add(q); queue.push(q);
        }
      }
      if (!edge && queue.length >= 3 && queue.length < (x1 - x0) * (y1 - y0) * .25 && (!best || queue.length > best.size)) best = { size: queue.length, x: sx / queue.length / source.width, y: sy / queue.length / source.height, color: rgb.map(v => Math.round(v / queue.length)) as RGB };
    }
    if (best) found.push({ position: [best.x, best.y], color: best.color });
  }
  return found;
}
