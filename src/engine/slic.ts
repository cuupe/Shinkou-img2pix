import type { FeatureMap } from './structure';
import type { RGB } from './types';

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : v * 841 / 108 + 4 / 29;
function labAt(data: Uint8ClampedArray, p: number): RGB {
  const r = LINEAR[data[p * 4]], g = LINEAR[data[p * 4 + 1]], b = LINEAR[data[p * 4 + 2]];
  const x = f((.4124564 * r + .3575761 * g + .1804375 * b) / .95047);
  const y = f(.2126729 * r + .7151522 * g + .072175 * b);
  const z = f((.0193339 * r + .119192 * g + .9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
interface Options { spacing: number; compactness?: number; iterations?: number }

/** Independent SLIC implementation: CIELAB + xy, local assignment, mean updates,
 * then split into 4-connected components. Small components are kept to protect ink.
 * Reference: Achanta et al., TPAMI 2012, doi:10.1109/TPAMI.2012.120.
 */
export function segmentSlic(data: Uint8ClampedArray, width: number, height: number, options: Options, onRegion?: (members: Int32Array) => void): Int32Array {
  const n = width * height, spacing = Math.max(2, Math.round(options.spacing));
  const labs = new Float32Array(n * 3), labels = new Int32Array(n).fill(-1), distances = new Float32Array(n);
  for (let p = 0; p < n; p++) if (data[p * 4 + 3]) labs.set(labAt(data, p), p * 3);
  // Centers have [L, a, b, x, y]. Each opaque tile contributes a seed, including
  // sparse subjects on transparent backgrounds where the tile center is empty.
  const centers: number[][] = [];
  const gradient = (p: number, x: number, y: number) => {
    let sum = 0;
    for (const q of [x > 0 ? p - 1 : p, x + 1 < width ? p + 1 : p, y > 0 ? p - width : p, y + 1 < height ? p + width : p]) {
      if (!data[q * 4 + 3]) { sum += 1e4; continue; }
      for (let k = 0; k < 3; k++) sum += (labs[p * 3 + k] - labs[q * 3 + k]) ** 2;
    }
    return sum;
  };
  for (let top = 0; top < height; top += spacing) for (let left = 0; left < width; left += spacing) {
    const right = Math.min(width, left + spacing), bottom = Math.min(height, top + spacing);
    const cx = Math.floor((left + right) / 2), cy = Math.floor((top + bottom) / 2);
    let best = -1, cost = Infinity;
    for (let y = Math.max(top, cy - 1); y <= Math.min(bottom - 1, cy + 1); y++) for (let x = Math.max(left, cx - 1); x <= Math.min(right - 1, cx + 1); x++) {
      const p = y * width + x; if (!data[p * 4 + 3]) continue;
      const value = gradient(p, x, y); if (value < cost) { best = p; cost = value; }
    }
    if (best < 0) for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const p = y * width + x; if (!data[p * 4 + 3]) continue;
      const value = (x - cx) ** 2 + (y - cy) ** 2; if (value < cost) { best = p; cost = value; }
    }
    if (best >= 0) centers.push([labs[best * 3], labs[best * 3 + 1], labs[best * 3 + 2], best % width, Math.floor(best / width)]);
  }
  const spatial = ((options.compactness ?? 10) / spacing) ** 2, sums = new Float64Array(centers.length * 6);
  for (let iteration = 0; iteration < (options.iterations ?? 6); iteration++) {
    distances.fill(Infinity); sums.fill(0);
    for (let k = 0; k < centers.length; k++) {
      const c = centers[k], left = Math.max(0, Math.floor(c[3] - spacing)), top = Math.max(0, Math.floor(c[4] - spacing));
      const right = Math.min(width - 1, Math.ceil(c[3] + spacing)), bottom = Math.min(height - 1, Math.ceil(c[4] + spacing));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const p = y * width + x; if (!data[p * 4 + 3]) continue;
        const d = (labs[p * 3] - c[0]) ** 2 + (labs[p * 3 + 1] - c[1]) ** 2 + (labs[p * 3 + 2] - c[2]) ** 2 + spatial * ((x - c[3]) ** 2 + (y - c[4]) ** 2);
        if (d < distances[p]) { distances[p] = d; labels[p] = k; }
      }
    }
    // If a moving window no longer visits a pixel, retain its previous assignment.
    for (let p = 0; p < n; p++) {
      const k = labels[p]; if (k < 0) continue; const i = k * 6;
      sums[i] += labs[p * 3]; sums[i + 1] += labs[p * 3 + 1]; sums[i + 2] += labs[p * 3 + 2];
      sums[i + 3] += p % width; sums[i + 4] += Math.floor(p / width); sums[i + 5]++;
    }
    for (let k = 0; k < centers.length; k++) if (sums[k * 6 + 5]) for (let d = 0; d < 5; d++) centers[k][d] = sums[k * 6 + d] / sums[k * 6 + 5];
  }
  const connected = new Int32Array(n).fill(-1), queue = new Int32Array(n);
  let region = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] < 0 || connected[start] >= 0) continue;
    let head = 0, tail = 1; queue[0] = start; connected[start] = region;
    while (head < tail) {
      const p = queue[head++], x = p % width;
      const visit = (q: number) => { if (q >= 0 && q < n && connected[q] < 0 && labels[q] === labels[start]) { connected[q] = region; queue[tail++] = q; } };
      if (x > 0) visit(p - 1); if (x + 1 < width) visit(p + 1); visit(p - width); visit(p + width);
    }
    onRegion?.(queue.subarray(0, tail)); region++;
  }
  return connected;
}

/** Region voting selects existing palette entries; it never averages new RGB
 * transition colors. Protected ridges, alpha and high-contrast minorities survive.
 */
export function cleanSuperpixels(original: Uint8ClampedArray, quantized: Uint8ClampedArray, width: number, height: number, palette: RGB[], features: FeatureMap, amount: number, spacing: number) {
  if (amount <= 0 || palette.length < 2) return 0;
  const strength = Math.min(1, amount / 100), votes = new Float32Array(palette.length);
  const lookup = new Map(palette.map((c, i) => [c[0] << 16 | c[1] << 8 | c[2], i]));
  const paletteLabs = palette.map(c => labAt(new Uint8ClampedArray([...c, 255]), 0));
  const index = (p: number) => lookup.get(quantized[p * 4] << 16 | quantized[p * 4 + 1] << 8 | quantized[p * 4 + 2]);
  let changed = 0;
  segmentSlic(original, width, height, { spacing }, members => {
    votes.fill(0); let total = 0, best = -1;
    for (const p of members) {
      if (features.importance[p] >= .2) continue;
      const k = index(p); if (k === undefined) continue;
      const weight = .1 + .9 * features.coherence[p]; votes[k] += weight; total += weight;
      if (best < 0 || votes[k] > votes[best]) best = k;
    }
    if (best < 0 || votes[best] / total < .95 - .25 * strength) return;
    for (const p of members) {
      if (features.importance[p] >= .2 || features.coherence[p] < .5) continue;
      const k = index(p); if (k === undefined || k === best) continue;
      const distance = Math.sqrt(paletteLabs[k].reduce((sum, v, d) => sum + (v - paletteLabs[best][d]) ** 2, 0));
      if (distance > 2 + 10 * strength) continue;
      quantized[p * 4] = palette[best][0]; quantized[p * 4 + 1] = palette[best][1]; quantized[p * 4 + 2] = palette[best][2]; changed++;
    }
  });
  return changed;
}
