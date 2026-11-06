import { labAt } from './slic';
import type { RGB, SemanticFace, Settings } from './types';
import { reconstructClusters, restoreStructuralSeams } from './pixel-clusters';
import { adjustedSemanticColor, refineSemanticGlyphs } from './semantic-reconstruction';

const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const distance = (a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number) => (a[ai] - b[bi]) ** 2 + (a[ai + 1] - b[bi + 1]) ** 2 + (a[ai + 2] - b[bi + 2]) ** 2;
function nearest(lab: ArrayLike<number>, offset: number, palette: RGB[]) {
  let best = 0, error = Infinity;
  for (let k = 0; k < palette.length; k++) { const d = distance(lab, offset, palette[k], 0); if (d < error) { best = k; error = d; } }
  return best;
}
function bilateral(input: Float32Array, width: number, height: number, radius: number, sigma: number, alpha?: Uint8ClampedArray) {
  const out = input.slice(), spatial: [number, number, number][] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) spatial.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius))]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x; if (alpha && !alpha[p * 4 + 3]) continue;
    let total = 0, l = 0, a = 0, b = 0;
    for (const [dx, dy, sw] of spatial) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
      const q = yy * width + xx; if (alpha && !alpha[q * 4 + 3]) continue;
      const w = sw * Math.exp(-distance(input, p * 3, input, q * 3) / (2 * sigma * sigma));
      total += w; l += input[q * 3] * w; a += input[q * 3 + 1] * w; b += input[q * 3 + 2] * w;
    }
    if (total) { out[p * 3] = l / total; out[p * 3 + 1] = a / total; out[p * 3 + 2] = b / total; }
  }
  return out;
}
function morphology(input: Float32Array, width: number, height: number, maximum: boolean, alpha: Uint8ClampedArray, radius = 2) {
  const out = input.slice();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x; if (!alpha[p * 4 + 3]) continue;
    let value = input[p];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = clamp(x + dx, 0, width - 1), yy = clamp(y + dy, 0, height - 1), q = yy * width + xx;
      if (alpha[q * 4 + 3]) value = maximum ? Math.max(value, input[q]) : Math.min(value, input[q]);
    }
    out[p] = value;
  }
  return out;
}

/** Content-adaptive grid with palette-constrained region assignments. Inspired
 * by Gerstner et al. 2012; this is not a reproduction of their MCDA optimizer.
 * Source regions can move within their cells; their neighbors keep a square
 * topology. No mandatory dark ridge bonus is used in this path.
 */
export function reconstruct(data: Uint8ClampedArray, sw: number, sh: number, width: number, height: number, palette: RGB[], settings: Settings, faces: SemanticFace[] = []) {
  const output = new Uint8ClampedArray(width * height * 4);
  if (!palette.length) return output;
  const n = width * height, samples = sw * sh, sx = sw / width, sy = sh / height, clarity = clamp((settings.pixelClarity ?? 70) / 100, 0, 1);
  const raw = new Float32Array(samples * 3), packedPalette = new Uint8ClampedArray(palette.length * 4);
  for (let p = 0; p < samples; p++) if (data[p * 4 + 3]) raw.set(labAt(data, p), p * 3);
  reserveSemanticColors(raw, data, palette, settings, faces);
  palette.forEach((rgb, k) => packedPalette.set([...rgb, 255], k * 4));
  const colors = palette.map((_, k) => labAt(packedPalette, k));
  const working = bilateral(raw, sw, sh, 2, 12, data);
  const light = Float32Array.from({ length: samples }, (_, p) => working[p * 3]);
  const closed = morphology(morphology(light, sw, sh, true, data), sw, sh, false, data);
  const protectedMap = new Float32Array(samples), semantic = clamp((settings.semanticDetail ?? 75) / 100, 0, 1);
  for (const face of faces) for (const [first, end] of [[11, 17], [17, 23], [24, 28]]) {
    const points = face.points.slice(first, end); if (points.length !== end - first || points.some(p => p[2] < .5)) continue;
    const x0 = clamp(Math.floor(Math.min(...points.map(p => p[0])) * sw - 1), 0, sw - 1), x1 = clamp(Math.ceil(Math.max(...points.map(p => p[0])) * sw + 2), 0, sw);
    const y0 = clamp(Math.floor(Math.min(...points.map(p => p[1])) * sh - 1), 0, sh - 1), y1 = clamp(Math.ceil(Math.max(...points.map(p => p[1])) * sh + 2), 0, sh);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) protectedMap[y * sw + x] = semantic;
  }
  const soften = 1 - clamp((settings.outlineRetention ?? 55) / 100, 0, 1);
  for (let p = 0; p < samples; p++) {
    const chroma = Math.hypot(working[p * 3 + 1], working[p * 3 + 2]);
    const ridge = clamp((closed[p] - light[p] - 3) / 18, 0, 1) * clamp((chroma - 8) / 15, 0, 1);
    working[p * 3] += soften * (1 - clarity * .55) * (1 - protectedMap[p]) * ridge * (closed[p] - light[p]);
  }
  const cx = new Float32Array(n), cy = new Float32Array(n), ox = new Float32Array(n), oy = new Float32Array(n);
  const means = new Float32Array(n * 3), mass = new Float64Array(n), coverage = new Float32Array(n), tileMass = new Uint32Array(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const k = y * width + x; cx[k] = ox[k] = (x + .5) * sx - .5; cy[k] = oy[k] = (y + .5) * sy - .5; }
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const p = y * sw + x, k = Math.min(height - 1, Math.floor((y + .5) / sy)) * width + Math.min(width - 1, Math.floor((x + .5) / sx));
    tileMass[k]++; if (!data[p * 4 + 3]) continue;
    mass[k]++; for (let d = 0; d < 3; d++) means[k * 3 + d] += working[p * 3 + d];
  }
  for (let k = 0; k < n; k++) { coverage[k] = mass[k] / Math.max(1, tileMass[k]); if (mass[k]) for (let d = 0; d < 3; d++) means[k * 3 + d] /= mass[k]; }
  const assignments = new Int32Array(samples), distances = new Float32Array(samples), sums = new Float64Array(n * 6), dx = new Float32Array(n), dy = new Float32Array(n);
  for (let iteration = 0; iteration < 16; iteration++) {
    const filtered = bilateral(means, width, height, 1, 9);
    distances.fill(Infinity); assignments.fill(-1); sums.fill(0);
    for (let k = 0; k < n; k++) {
      if (coverage[k] === 0) continue;
      const color = colors[nearest(filtered, k * 3, colors)];
      const left = Math.max(0, Math.floor(cx[k] - sx)), right = Math.min(sw - 1, Math.ceil(cx[k] + sx));
      const top = Math.max(0, Math.floor(cy[k] - sy)), bottom = Math.min(sh - 1, Math.ceil(cy[k] + sy));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const p = y * sw + x; if (!data[p * 4 + 3]) continue;
        const cost = distance(working, p * 3, color, 0) + 784 * (((x - cx[k]) / sx) ** 2 + ((y - cy[k]) / sy) ** 2);
        if (cost < distances[p]) { distances[p] = cost; assignments[p] = k; }
      }
    }
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const p = y * sw + x; if (!data[p * 4 + 3]) continue;
      let k = assignments[p];
      if (k < 0) k = Math.min(height - 1, Math.floor((y + .5) / sy)) * width + Math.min(width - 1, Math.floor((x + .5) / sx));
      const i = k * 6;
      for (let d = 0; d < 3; d++) sums[i + d] += working[p * 3 + d];
      sums[i + 3] += x; sums[i + 4] += y; sums[i + 5]++;
    }
    for (let k = 0; k < n; k++) {
      const i = k * 6, count = sums[i + 5];
      if (count) { for (let d = 0; d < 3; d++) means[k * 3 + d] = sums[i + d] / count; }
      dx[k] = count ? clamp(sums[i + 3] / count - ox[k], -.45 * sx, .45 * sx) : 0;
      dy[k] = count ? clamp(sums[i + 4] / count - oy[k], -.45 * sy, .45 * sy) : 0;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const k = y * width + x; let ax = 0, ay = 0, count = 0;
      for (const q of [x > 0 ? k - 1 : -1, x + 1 < width ? k + 1 : -1, y > 0 ? k - width : -1, y + 1 < height ? k + width : -1]) if (q >= 0) { ax += dx[q]; ay += dy[q]; count++; }
      cx[k] = ox[k] + .6 * dx[k] + .4 * (count ? ax / count : 0);
      cy[k] = oy[k] + .6 * dy[k] + .4 * (count ? ay / count : 0);
    }
  }
  const labels = Int16Array.from({ length: n }, (_, k) => coverage[k] >= .5 ? nearest(means, k * 3, colors) : -1);
  reconstructClusters(labels, working, data, sw, sh, width, height, assignments, colors, clarity, protectedMap);
  restoreStructuralSeams(labels, raw, closed, light, data, sw, sh, width, height, colors, (settings.outlineRetention ?? 55) / 100, clarity, protectedMap, faces);
  restoreCompactStrokes(labels, raw, data, sw, sh, width, height, colors, clamp(settings.lineProtection / 100, 0, 1), clarity);
  if (semantic > 0) {
    refineFeatures(labels, raw, sw, sh, width, height, colors, faces, semantic, clarity);
    refineSemanticGlyphs(labels, raw, sw, sh, width, height, colors, faces, settings);
  }
  labels.forEach((k, p) => { if (k >= 0) output.set([...palette[k], 255], p * 4); });
  return output;
}

function reserveSemanticColors(raw: Float32Array, data: Uint8ClampedArray, palette: RGB[], settings: Settings, faces: SemanticFace[]) {
  if (settings.palette !== 'adaptive' || palette.length < 8 || settings.semanticDetail < 30) return;
  const samples = faces.flatMap(face => face.highlightColors ?? []);
  const targets: RGB[] = samples.length ? [[0, 1, 2].map(k => samples.reduce((s, c) => s + c[k], 0) / samples.length) as RGB] : [];
  if ((settings.pixelClarity ?? 70) > 0) for (const face of faces) for (const eye of face.eyes ?? []) targets.push(eye.iris, eye.irisLight);
  const reserved = new Set<number>(), limit = Math.max(1, Math.min(4, Math.floor(palette.length / 4)));
  for (const rgb of targets) {
    if (reserved.size >= limit) break;
    const adjusted = adjustedSemanticColor(rgb, settings);
    const packed = new Uint8ClampedArray((palette.length + 1) * 4); palette.forEach((c, k) => packed.set([...c, 255], k * 4)); packed.set([...adjusted, 255], palette.length * 4);
    const labs = palette.map((_, k) => labAt(packed, k)), target = labAt(packed, palette.length);
    const existing = nearest(target, 0, labs);
    if (distance(labs[existing], 0, target, 0) < ((settings.pixelClarity ?? 70) > 0 ? 36 : 16)) { reserved.add(existing); continue; }
    const frequency = new Uint32Array(palette.length);
    for (let p = 0; p < data.length / 4; p++) if (data[p * 4 + 3]) frequency[nearest(raw, p * 3, labs)]++;
    let best = -1, cost = Infinity;
    for (let k = 0; k < palette.length; k++) {
      if (reserved.has(k)) continue;
      let neighbor = Infinity;
      for (let j = 0; j < palette.length; j++) if (j !== k) neighbor = Math.min(neighbor, distance(labs[k], 0, labs[j], 0));
      const loss = frequency[k] * neighbor;
      if (loss < cost) { cost = loss; best = k; }
    }
    if (best >= 0) { palette[best] = adjusted; reserved.add(best); }
  }
}

// A compact, thin mark surrounded by a stable color field can deserve one
// connected pixel stroke even when it is not a human face (cartoon muzzles,
// small symbols). Long boundary networks and mixed-color neighborhoods fail
// these tests. The stroke uses a tinted palette color, not compulsory black.
function restoreCompactStrokes(labels: Int16Array, lab: Float32Array, rgba: Uint8ClampedArray, sw: number, sh: number, width: number, height: number, palette: RGB[], strength: number, clarity: number) {
  if (strength <= 0) return;
  const sx = sw / width, sy = sh / height, light = Float32Array.from({ length: sw * sh }, (_, p) => lab[p * 3]);
  const closed = morphology(morphology(light, sw, sh, true, rgba, 4), sw, sh, false, rgba, 4);
  const mask = Uint8Array.from(light, (v, p) => rgba[p * 4 + 3] && closed[p] - v > 5 ? 1 : 0);
  const dilated = new Uint8Array(mask.length), connected = new Uint8Array(mask.length);
  for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
    const p = y * sw + x;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (mask[p + dy * sw + dx]) dilated[p] = 1;
  }
  for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
    const p = y * sw + x; let all = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!dilated[p + dy * sw + dx]) all = false;
    connected[p] = all ? 1 : 0;
  }
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!connected[start] || seen[start]) continue;
    let head = 0, tail = 1, left = sw, right = 0, top = sh, bottom = 0;
    queue[0] = start; seen[start] = 1;
    const members: number[] = [];
    while (head < tail) {
      const p = queue[head++], x = p % sw, y = Math.floor(p / sw);
      if (mask[p]) { members.push(p); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, q = yy * sw + xx;
        if (xx < 0 || xx >= sw || yy < 0 || yy >= sh || seen[q] || !connected[q]) continue;
        seen[q] = 1; queue[tail++] = q;
      }
    }
    if (members.length < .15 * sx * sy || members.length > 8 * sx * sy || right - left < sx * .7 || right - left > sx * 8 || bottom - top > sy * 5 || left < sx || top < sy || right >= sw - sx || bottom >= sh - sy) continue;
    const ring: number[][] = [[], [], []];
    for (let y = Math.max(0, top - Math.ceil(sy)); y <= Math.min(sh - 1, bottom + Math.ceil(sy)); y++) for (let x = Math.max(0, left - Math.ceil(sx)); x <= Math.min(sw - 1, right + Math.ceil(sx)); x++) {
      const p = y * sw + x; if (mask[p] || !rgba[p * 4 + 3]) continue;
      for (let d = 0; d < 3; d++) ring[d].push(lab[p * 3 + d]);
    }
    if (!ring[0].length) continue;
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const background = ring.map(median); let coherent = 0;
    for (let i = 0; i < ring[0].length; i++) if ((ring[0][i] - background[0]) ** 2 + (ring[1][i] - background[1]) ** 2 + (ring[2][i] - background[2]) ** 2 < 100) coherent++;
    if (coherent / ring[0].length < .83) continue;
    const ink = [0, 1, 2].map(d => median(members.map(p => lab[p * 3 + d]))), amount = .3 + .2 * strength + .2 * clarity;
    if (background[0] - ink[0] < 9) continue;
    const target = ink.map((v, d) => v * amount + background[d] * (1 - amount));
    let color = -1, error = Infinity;
    // Nearest color alone can snap a faint but real mouth back to its background.
    // Require modest measured contrast and reject a badly mismatched color.
    const minimumContrast = Math.max(3, (background[0] - ink[0]) * .3);
    palette.forEach((c, k) => { const cost = distance(c, 0, target, 0); if (background[0] - c[0] >= minimumContrast && cost < error) { color = k; error = cost; } });
    if (color < 0 || error > 256) continue;
    const path: [number, number][] = [];
    const memberSet = new Set(members);
    for (let x = left; x <= right; x++) {
      let total = 0, sum = 0;
      for (let y = top; y <= bottom; y++) { const p = y * sw + x; if (!memberSet.has(p)) continue; const weight = Math.max(0, background[0] - lab[p * 3]); total += weight; sum += y * weight; }
      if (total) path.push([x, sum / total]);
    }
    if (path.length < (right - left) * .5) continue;
    const length = Math.max(1, Math.round((right - left + 1) / sx)), centerX = path.reduce((s, p) => s + p[0], 0) / path.length / sx, meanY = path.reduce((s, p) => s + p[1], 0) / path.length;
    const gx = Math.round(centerX - (length - 1) / 2 - .5), gy = Math.round(meanY / sy - .5); let cursor = 0;
    for (let i = 0; i < length; i++) {
      const px = left + (right - left) * (length > 1 ? i / (length - 1) : .5);
      while (cursor + 1 < path.length && path[cursor + 1][0] < px) cursor++;
      const a = path[cursor], b = path[Math.min(path.length - 1, cursor + 1)], t = a[0] === b[0] ? 0 : (px - a[0]) / (b[0] - a[0]);
      const x = gx + i, y = gy + Math.round((a[1] * (1 - t) + b[1] * t - meanY) / sy), p = y * width + x;
      if (x >= 0 && x < width && y >= 0 && y < height && labels[p] >= 0 && palette[labels[p]][0] > palette[color][0]) labels[p] = color;
    }
  }
}

// Landmarks propose ROIs; the original image must independently support each
// highlight/stroke. No generic eyes/mouth sprites are stamped onto the image.
function refineFeatures(labels: Int16Array, raw: Float32Array, sw: number, sh: number, width: number, height: number, palette: RGB[], faces: SemanticFace[], strength: number, clarity: number) {
  const put = (x: number, y: number, color: number) => { if (x >= 0 && x < width && y >= 0 && y < height && labels[y * width + x] >= 0) labels[y * width + x] = color; };
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const face of faces) {
    if (face.points.length !== 28) continue;
    if (strength >= .3) for (const [x, y] of face.highlights ?? []) {
      const eye = face.points.slice(x < (face.points[13][0] + face.points[17][0]) / 2 ? 11 : 17, x < (face.points[13][0] + face.points[17][0]) / 2 ? 17 : 23);
      if ((Math.max(...eye.map(p => p[0])) - Math.min(...eye.map(p => p[0]))) * width >= 2.2) put(Math.floor(x * width), Math.floor(y * height), nearest([97, 0, 0], 0, palette));
    }
    for (const [first, end] of [[11, 17], [17, 23]]) {
      const points = face.points.slice(first, end); if (points.some(p => p[2] < .55)) continue;
      const left = Math.min(...points.map(p => p[0])), right = Math.max(...points.map(p => p[0])), top = Math.min(...points.map(p => p[1])), bottom = Math.max(...points.map(p => p[1]));
      if ((right - left) * width < 2.2 || (bottom - top) * height < 1.6 || strength < .3) continue;
      const x0 = clamp(Math.floor(left * sw - 1), 0, sw - 1), x1 = clamp(Math.ceil(right * sw + 1), 0, sw), y0 = clamp(Math.floor(top * sh - 1), 0, sh - 1), y1 = clamp(Math.ceil(bottom * sh + 1), 0, sh);
      const seen = new Set<number>(); let best: { size: number; x: number; y: number } | undefined;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const start = y * sw + x;
        const white = (p: number) => raw[p * 3] > 85 && Math.hypot(raw[p * 3 + 1], raw[p * 3 + 2]) < 18;
        if (seen.has(start) || !white(start)) continue;
        const queue = [start]; seen.add(start); let ax = 0, ay = 0, edge = false;
        for (let head = 0; head < queue.length; head++) {
          const p = queue[head], xx = p % sw, yy = Math.floor(p / sw); ax += xx + .5; ay += yy + .5;
          if (xx === x0 || xx === x1 - 1 || yy === y0 || yy === y1 - 1) edge = true;
          for (const [nx, ny] of [[xx - 1, yy], [xx + 1, yy], [xx, yy - 1], [xx, yy + 1]]) {
            const q = ny * sw + nx; if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1 || seen.has(q) || !white(q)) continue;
            seen.add(q); queue.push(q);
          }
        }
        if (!edge && queue.length >= 2 && (!best || queue.length > best.size)) best = { size: queue.length, x: ax / queue.length / sw, y: ay / queue.length / sh };
      }
      if (best) put(Math.floor(best.x * width), Math.floor(best.y * height), nearest([97, 0, 0], 0, palette));
    }
    const points = face.points.slice(24, 28); if (points.some(p => p[2] < .6) || strength < .25) continue;
    const left = Math.min(...points.map(p => p[0])) * sw, right = Math.max(...points.map(p => p[0])) * sw, top = Math.min(...points.map(p => p[1])) * sh, bottom = Math.max(...points.map(p => p[1])) * sh;
    const span = right - left;
    if (span < 2 || bottom - top > span * .4) continue; // Open mouths keep their area; do not turn them into a smile.
    const x0 = clamp(Math.floor(left), 0, sw - 1), x1 = clamp(Math.ceil(right), 0, sw - 1), y0 = clamp(Math.floor(top - span * .13), 0, sh - 1), y1 = clamp(Math.ceil(bottom + span * .13), 0, sh - 1);
    const channels: number[][] = [[], [], []];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let d = 0; d < 3; d++) channels[d].push(raw[(y * sw + x) * 3 + d]);
    const background = channels.map(median), path: [number, number][] = [], inks: number[][] = [[], [], []];
    let inkCount = 0;
    for (let x = x0; x <= x1; x++) {
      let total = 0, ySum = 0, best = -1, maximum = 0;
      for (let y = y0; y <= y1; y++) {
        const p = y * sw + x, ink = Math.max(0, background[0] - raw[p * 3] - 9);
        total += ink; ySum += y * ink; if (ink > 8) inkCount++;
        if (ink > maximum) { maximum = ink; best = p; }
      }
      if (maximum > 8 && total && best >= 0) { path.push([x, ySum / total]); for (let d = 0; d < 3; d++) inks[d].push(raw[best * 3 + d]); }
    }
    if (path.length < span * .35 || inkCount / ((x1 - x0 + 1) * (y1 - y0 + 1)) > .35) continue;
    const amount = .3 + .2 * strength + clarity * .4, color = nearest(inks.map((a, d) => median(a) * amount + background[d] * (1 - amount)), 0, palette), base = nearest(background, 0, palette);
    const length = Math.max(1, Math.round(span / sw * width));
    const centerX = path.reduce((sum, p) => sum + p[0], 0) / path.length / sw * width, meanY = path.reduce((sum, p) => sum + p[1], 0) / path.length;
    const gx = Math.round(centerX - (length - 1) / 2 - .5), gy = Math.round(meanY / sh * height - .5);
    // Replace only the supported closed-mouth patch before drawing its measured
    // centerline with a local grid phase. This avoids two detached lip fragments.
    for (let y = Math.floor(y0 / sh * height); y <= Math.floor(y1 / sh * height); y++) for (let x = Math.floor(x0 / sw * width); x <= Math.floor(x1 / sw * width); x++) put(x, y, base);
    let cursor = 0;
    for (let i = 0; i < length; i++) {
      const px = path[0][0] + (path[path.length - 1][0] - path[0][0]) * (length > 1 ? i / (length - 1) : .5);
      while (cursor + 1 < path.length && path[cursor + 1][0] < px) cursor++;
      const a = path[cursor], b = path[Math.min(path.length - 1, cursor + 1)], t = a[0] === b[0] ? 0 : (px - a[0]) / (b[0] - a[0]);
      put(gx + i, gy + Math.round((a[1] * (1 - t) + b[1] * t - meanY) / sh * height), color);
    }
  }
}
