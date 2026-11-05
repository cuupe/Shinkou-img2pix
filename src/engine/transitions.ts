import type { FeatureMap } from './structure';
import type { RGB } from './types';

/** Remove a transition color only when it can be explained as a mixture of two
 * stable, locally present region colors. This local ownership prevents a global
 * palette's unrelated green/gray from leaking into a black/white eye boundary.
 * A real third color which is not on that local color segment is left intact.
 */
export function resolveTransitions(original: Uint8ClampedArray, quantized: Uint8ClampedArray, width: number, height: number, palette: RGB[], features: FeatureMap) {
  if (palette.length < 2) return;
  const lookup = new Map(palette.map((c, i) => [c[0] << 16 | c[1] << 8 | c[2], i]));
  const labels = new Int16Array(width * height).fill(-1);
  for (let p = 0; p < labels.length; p++) if (quantized[p * 4 + 3]) labels[p] = lookup.get(quantized[p * 4] << 16 | quantized[p * 4 + 1] << 8 | quantized[p * 4 + 2]) ?? -1;
  const cores = new Uint8Array(labels.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (features.coherence[p] >= .65) { cores[p] = 1; continue; }
    if (features.importance[p] < .65 || features.coherence[p] < .2) continue;
    let lo = 1, hi = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const q = yy * width + xx;
      if (labels[q] < 0) continue;
      lo = Math.min(lo, features.luminance[q]); hi = Math.max(hi, features.luminance[q]);
    }
    const l = features.luminance[p];
    if (l <= lo + .025 || l >= hi - .025) cores[p] = 1;
  }
  const counts = new Float32Array(palette.length), candidates: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (labels[p] < 0 || features.coherence[p] >= .65) continue;
    counts.fill(0); candidates.length = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const q = yy * width + xx, label = labels[q];
      if (label < 0 || !cores[q]) continue;
      if (!counts[label]) candidates.push(label);
      counts[label] += 1 / (1 + dx * dx + dy * dy);
    }
    if (candidates.length < 2) continue;
    candidates.sort((a, b) => counts[b] - counts[a]);
    const c0 = original[p * 4], c1 = original[p * 4 + 1], c2 = original[p * 4 + 2];
    let bestResidual = 100, chosen = -1;
    for (let a = 0; a < Math.min(6, candidates.length); a++) for (let b = a + 1; b < Math.min(6, candidates.length); b++) {
      const ca = palette[candidates[a]], cb = palette[candidates[b]];
      const dr = cb[0] - ca[0], dg = cb[1] - ca[1], db = cb[2] - ca[2];
      const length = dr * dr + dg * dg + db * db;
      if (length < 1600) continue;
      const t = ((c0 - ca[0]) * dr + (c1 - ca[1]) * dg + (c2 - ca[2]) * db) / length;
      if (t < .08 || t > .92) continue;
      const residual = ((c0 - ca[0] - t * dr) ** 2 + (c1 - ca[1] - t * dg) ** 2 + (c2 - ca[2] - t * db) ** 2) / 3;
      if (residual < bestResidual) {
        bestResidual = residual;
        chosen = t < .5 ? candidates[a] : candidates[b];
      }
    }
    if (chosen >= 0) quantized.set([...palette[chosen], 255], p * 4);
  }
}
