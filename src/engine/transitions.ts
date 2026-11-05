import type { FeatureMap } from './structure';
import type { RGB } from './types';

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
});
const SRGB = Float32Array.from({ length: 4097 }, (_, i) => {
  const v = i / 4096; return 255 * (v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055);
});
const encoded = (v: number) => SRGB[Math.max(0, Math.min(4096, Math.round(v * 4096)))];

/** Remove a transition color only when it can be explained as a mixture of two
 * stable, locally present region colors. This local ownership prevents a global
 * palette's unrelated green/gray from leaking into a black/white eye boundary.
 * A real third color which is not on that local color segment is left intact.
 */
export function resolveTransitions(original: Uint8ClampedArray, quantized: Uint8ClampedArray, width: number, height: number, palette: RGB[], features: FeatureMap, retention = 25) {
  const keep = Math.max(0, Math.min(1, retention / 100));
  if (palette.length < 2 || keep >= 1) return;
  const linearPalette = palette.map(c => c.map(v => LINEAR[v]));
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
  const counts = new Float32Array(palette.length), sumX = new Float32Array(palette.length), sumY = new Float32Array(palette.length), candidates: number[] = [];
  const radius = 3, tolerance = 14, unstableLimit = 1.01 - .5 * keep;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (labels[p] < 0 || features.coherence[p] >= unstableLimit) continue;
    if (features.coherence[p] >= .99) {
      // Flat interiors do not need the 7x7 search, even at maximum suppression.
      let boundary = false;
      for (const [dx, dy] of [[-radius, 0], [radius, 0], [0, -radius], [0, radius]]) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < width && yy < height && labels[yy * width + xx] !== labels[p]) boundary = true;
      }
      if (!boundary) continue;
    }
    counts.fill(0); sumX.fill(0); sumY.fill(0); candidates.length = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const q = yy * width + xx, label = labels[q];
      if (label < 0 || !cores[q]) continue;
      if (!counts[label]) candidates.push(label);
      const weight = 1 / (1 + dx * dx + dy * dy);
      counts[label] += weight; sumX[label] += dx * weight; sumY[label] += dy * weight;
    }
    if (candidates.length < 2) continue;
    candidates.sort((a, b) => counts[b] - counts[a]);
    const c0 = original[p * 4], c1 = original[p * 4 + 1], c2 = original[p * 4 + 2];
    let bestResidual = tolerance * tolerance, chosen = -1, bestMix = 0;
    for (let a = 0; a < Math.min(6, candidates.length); a++) for (let b = a + 1; b < Math.min(6, candidates.length); b++) {
      const ca = palette[candidates[a]], cb = palette[candidates[b]];
      const ax = sumX[candidates[a]] / counts[candidates[a]], ay = sumY[candidates[a]] / counts[candidates[a]];
      const bx = sumX[candidates[b]] / counts[candidates[b]], by = sumY[candidates[b]] / counts[candidates[b]];
      // Both colors must bracket the pixel, not merely occur on the same side.
      if (ax * bx + ay * by >= -.05 * Math.hypot(ax, ay) * Math.hypot(bx, by)) continue;
      const dr = cb[0] - ca[0], dg = cb[1] - ca[1], db = cb[2] - ca[2];
      const length = dr * dr + dg * dg + db * db;
      if (length < 1600) continue;
      let t = ((c0 - ca[0]) * dr + (c1 - ca[1]) * dg + (c2 - ca[2]) * db) / length;
      let residual = ((c0 - ca[0] - t * dr) ** 2 + (c1 - ca[1] - t * dg) ** 2 + (c2 - ca[2] - t * db) ** 2) / 3;
      // Area sampling mixes in linear light, whose encoded RGB colors follow a
      // curve rather than a straight RGB segment. Recognize that path too.
      const la = linearPalette[candidates[a]], lb = linearPalette[candidates[b]];
      const lr = lb[0] - la[0], lg = lb[1] - la[1], lblue = lb[2] - la[2];
      const lt = ((LINEAR[c0] - la[0]) * lr + (LINEAR[c1] - la[1]) * lg + (LINEAR[c2] - la[2]) * lblue) / (lr * lr + lg * lg + lblue * lblue);
      if (lt >= .04 && lt <= .96) {
        const linearResidual = ((c0 - encoded(la[0] + lt * lr)) ** 2 + (c1 - encoded(la[1] + lt * lg)) ** 2 + (c2 - encoded(la[2] + lt * lblue)) ** 2) / 3;
        if (linearResidual < residual) { t = lt; residual = linearResidual; }
      }
      if (t < .04 || t > .96) continue;
      if (residual < bestResidual) {
        bestResidual = residual;
        chosen = t < .5 ? candidates[a] : candidates[b];
        bestMix = 2 * Math.min(t, 1 - t);
      }
    }
    const confidence = (1 - Math.sqrt(bestResidual) / tolerance) * (.5 + .5 * bestMix) * (1 - .4 * features.coherence[p]);
    // Retention controls which transitions survive, never a noisy random mask or
    // an RGB blend. Every changed pixel still uses one existing region color.
    if (chosen >= 0 && confidence >= keep) quantized.set([...palette[chosen], 255], p * 4);
  }
}
