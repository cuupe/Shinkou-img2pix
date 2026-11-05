import type { RGB } from './types';

export interface FeatureMap { importance: Float32Array; luminance: Float32Array }

/** Detect narrow dark AND bright ridges before shrinking them to a single cell.
 * Opposing samples distinguish a thin line from an ordinary region boundary.
 * This is an independently implemented geometric heuristic, not a neural model.
 */
export function detectFeatures(data: Uint8ClampedArray, width: number, height: number): FeatureMap {
  const luminance = new Float32Array(width * height), raw = new Float32Array(width * height);
  for (let p = 0; p < luminance.length; p++) {
    const i = p * 4;
    luminance[p] = (data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722) / 255;
  }
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (!data[p * 4 + 3]) continue;
    let best = 0;
    for (const [dx, dy] of directions) for (const radius of [1, 2]) {
      const ax = x - dx * radius, ay = y - dy * radius, bx = x + dx * radius, by = y + dy * radius;
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= width || ay >= height || bx >= width || by >= height) continue;
      const a = ay * width + ax, b = by * width + bx;
      if (!data[a * 4 + 3] || !data[b * 4 + 3]) continue;
      const da = luminance[a] - luminance[p], db = luminance[b] - luminance[p];
      if (da * db <= 0) continue;
      const contrast = Math.min(Math.abs(da), Math.abs(db));
      const symmetry = Math.max(0, 1 - Math.abs(luminance[a] - luminance[b]) / .35);
      best = Math.max(best, Math.max(0, contrast - .055) / .28 * symmetry);
    }
    raw[p] = Math.min(1, best);
  }
  const importance = new Float32Array(raw.length);
  // Isolated strong features are retained (eye highlights); weak texture is gated
  // by same-colored neighbors so that random texture cannot masquerade as a line.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x; if (!raw[p]) continue;
    let support = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const q = (y + dy) * width + x + dx;
      if (Math.abs(luminance[p] - luminance[q]) < .12) support = Math.max(support, raw[q]);
    }
    importance[p] = Math.max(raw[p] * .4, Math.min(raw[p], support), raw[p] > .9 ? raw[p] : 0);
  }
  return { importance, luminance };
}

interface StructureResult { data: Uint8ClampedArray; protected: Float32Array; labels: Int16Array; coverage: Float32Array }

/** Map coherent palette regions into cells instead of blending boundary colors.
 * Every output color is an existing palette color. A minority high-contrast
 * ridge can claim one cell, preventing narrow lashes and highlights averaging away.
 */
export function mapRegions(data: Uint8ClampedArray, sw: number, sh: number, width: number, height: number, palette: RGB[], features: FeatureMap, protection: number): StructureResult {
  const output = new Uint8ClampedArray(width * height * 4);
  const labels = new Int16Array(width * height).fill(-1), protectedMap = new Float32Array(labels.length), coverage = new Float32Array(labels.length);
  if (!palette.length) return { data: output, protected: protectedMap, labels, coverage };
  const colors = new Map(palette.map((c, i) => [c[0] << 16 | c[1] << 8 | c[2], i]));
  const sourceLabels = new Int16Array(sw * sh).fill(-1);
  for (let p = 0; p < sourceLabels.length; p++) if (data[p * 4 + 3]) sourceLabels[p] = colors.get(data[p * 4] << 16 | data[p * 4 + 1] << 8 | data[p * 4 + 2]) ?? -1;
  const votes = new Float32Array(palette.length), centers = new Float32Array(palette.length), ridge = new Float32Array(palette.length);
  const sx = sw / width, sy = sh / height, strength = Math.max(0, Math.min(1, protection / 100));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    votes.fill(0); centers.fill(0); ridge.fill(0);
    const left = x * sx, right = (x + 1) * sx, top = y * sy, bottom = (y + 1) * sy;
    let opaque = 0, centerTotal = 0;
    for (let yy = Math.floor(top); yy < Math.ceil(bottom); yy++) for (let xx = Math.floor(left); xx < Math.ceil(right); xx++) {
      const weight = (Math.min(bottom, yy + 1) - Math.max(top, yy)) * (Math.min(right, xx + 1) - Math.max(left, xx));
      const p = Math.min(yy, sh - 1) * sw + Math.min(xx, sw - 1), index = sourceLabels[p];
      if (index < 0) continue;
      const dx = (xx + .5 - (left + right) / 2) / sx, dy = (yy + .5 - (top + bottom) / 2) / sy;
      const center = weight * Math.exp(-5 * (dx * dx + dy * dy));
      votes[index] += weight; centers[index] += center;
      ridge[index] = Math.max(ridge[index], features.importance[p]);
      opaque += weight; centerTotal += center;
    }
    const p = y * width + x;
    coverage[p] = opaque / (sx * sy);
    // Transparency is a region too. Do not expand a colored ridge into empty space.
    if (coverage[p] < .5) continue;
    let best = 0, bestScore = -1;
    for (let k = 0; k < palette.length; k++) {
      if (!votes[k]) continue;
      const fraction = votes[k] / opaque;
      const ridgeScore = ridge[k] * strength * 1.6 * (1 - fraction) * Math.min(1, fraction / .09);
      const score = fraction * .85 + centers[k] / centerTotal * .15 + ridgeScore;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    labels[p] = best; protectedMap[p] = ridge[best];
    output.set([...palette[best], 255], p * 4);
  }
  return { data: output, protected: protectedMap, labels, coverage };
}

/** Conservative topology check: only isolated, unprotected singleton regions can
 * be merged. Never majority-filter whole edges or erase one-cell-wide chains.
 */
export function cleanRegions(result: StructureResult, width: number, height: number, palette: RGB[], amount: number) {
  if (amount <= 0 || !palette.length) return;
  const original = result.labels.slice(), strength = Math.max(0, Math.min(1, amount / 100));
  const counts = new Uint8Array(palette.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const p = y * width + x, current = original[p];
    if (current < 0 || result.protected[p] >= .18 || result.coverage[p] < .99) continue;
    counts.fill(0); let connected = false, transparentNeighbor = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const label = original[(y + dy) * width + x + dx];
      if (label === current) connected = true;
      if (label < 0) transparentNeighbor = true; else counts[label]++;
    }
    if (connected || transparentNeighbor) continue;
    let best = current;
    for (let i = 0; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
    if (counts[best] < (strength < .7 ? 7 : 6)) continue;
    const distance = Math.sqrt(palette[best].reduce((sum, v, k) => sum + (v - palette[current][k]) ** 2, 0) / 3);
    if (distance > 8 + strength * 65) continue;
    result.labels[p] = best; result.data.set([...palette[best], 255], p * 4);
  }
}
