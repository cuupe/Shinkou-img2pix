import type { RGB, SemanticFace } from './types';

const delta = (a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi = 0) => (a[ai] - b[bi]) ** 2 + (a[ai + 1] - b[bi + 1]) ** 2 + (a[ai + 2] - b[bi + 2]) ** 2;
function nearest(a: ArrayLike<number>, p: number, colors: RGB[]) {
  let best = 0, error = Infinity;
  for (let k = 0; k < colors.length; k++) { const cost = delta(a, p, colors[k]); if (cost < error) { best = k; error = cost; } }
  return best;
}

/** Source-supported discrete color votes. A mixed mean cannot introduce a
 * middle shade absent from the region. Near colors share a bounded cluster;
 * complete-link checks prevent a chain of similar shades flattening a ramp.
 * The palette itself is never expanded or rewritten by this stage. */
export function reconstructClusters(labels: Int16Array, lab: Float32Array, rgba: Uint8ClampedArray, sw: number, sh: number, width: number, height: number, assignments: Int32Array, colors: RGB[], clarity: number, protectedMap: Float32Array) {
  if (clarity <= 0 || colors.length < 2) return;
  const n = width * height, count = colors.length, source = new Int16Array(sw * sh).fill(-1), frequency = new Uint32Array(count);
  for (let p = 0; p < source.length; p++) if (rgba[p * 4 + 3]) { source[p] = nearest(lab, p * 3, colors); frequency[source[p]]++; }
  const groups = colors.map((_, k) => [k]), threshold = (3 + clarity * 7) ** 2;
  for (;;) {
    let a = -1, b = -1, cost = threshold;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      let maximum = 0;
      for (const k of groups[i]) for (const l of groups[j]) maximum = Math.max(maximum, delta(colors[k], 0, colors[l]));
      if (maximum < cost) { cost = maximum; a = i; b = j; }
    }
    if (a < 0) break;
    groups[a].push(...groups[b]); groups.splice(b, 1);
  }
  const canonical = new Int16Array(count);
  for (const members of groups) { const key = members.reduce((a, b) => frequency[a] >= frequency[b] ? a : b); for (const k of members) canonical[k] = key; }
  const votes = new Float32Array(n * count), totals = new Float32Array(n), protection = new Float32Array(n), sx = sw / width, sy = sh / height;
  for (let p = 0; p < source.length; p++) {
    const region = assignments[p], color = source[p]; if (region < 0 || color < 0 || labels[region] < 0) continue;
    const x = p % sw, y = Math.floor(p / sw), cx = (region % width + .5) * sx - .5, cy = (Math.floor(region / width) + .5) * sy - .5;
    const weight = .6 + .4 * Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
    votes[region * count + canonical[color]] += weight; totals[region] += weight; protection[region] = Math.max(protection[region], protectedMap[p]);
  }
  const candidates = labels.slice();
  for (let k = 0; k < n; k++) {
    if (labels[k] < 0 || !totals[k] || protection[k] > .1) continue;
    let best = canonical[labels[k]], cost = -Infinity;
    for (let c = 0; c < count; c++) {
      if (canonical[c] !== c || !votes[k * count + c]) continue;
      const support = votes[k * count + c] / totals[k];
      // At low strength, stay close to the established regional mean. High
      // strength gives the actual source's dominant color more influence.
      const value = support - (1 - clarity) * Math.min(1, delta(colors[c], 0, colors[labels[k]]) / 900) * .6;
      if (value > cost) { best = c; cost = value; }
    }
    candidates[k] = best;
  }
  labels.set(candidates);
  // Only merge tiny, low-contrast islands when a larger adjacent region has
  // supporting source votes. Dark strokes, alpha edges and facial ROIs survive.
  const seen = new Uint8Array(n), queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] || labels[start] < 0) continue;
    let head = 0, tail = 1; queue[0] = start; seen[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width;
      for (const q of [x ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p - width, p + width]) if (q >= 0 && q < n && !seen[q] && labels[q] === labels[start]) { seen[q] = 1; queue[tail++] = q; }
    }
    if (tail > 2 || clarity < .2) continue;
    const neighbors = new Map<number, number>(); let protectedRegion = false;
    for (let i = 0; i < tail; i++) {
      const p = queue[i], x = p % width; protectedRegion ||= protection[p] > .1;
      for (const q of [x ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p - width, p + width]) {
        if (q < 0 || q >= n || labels[q] < 0) { protectedRegion = true; continue; }
        if (labels[q] !== labels[start]) neighbors.set(labels[q], (neighbors.get(labels[q]) ?? 0) + 1);
      }
    }
    if (protectedRegion) continue;
    let best = -1, score = 0;
    for (const [color, touches] of neighbors) {
      if (touches < 2 || delta(colors[color], 0, colors[labels[start]]) > (5 + clarity * 12) ** 2) continue;
      let evidence = 0; for (let i = 0; i < tail; i++) evidence += votes[queue[i] * count + color] / Math.max(1, totals[queue[i]]);
      const value = touches * evidence; if (value > score) { best = color; score = value; }
    }
    if (best >= 0) for (let i = 0; i < tail; i++) labels[queue[i]] = best;
  }
}

/** Rasterize a measured thin seam only when its two sides belong to different
 * substantial color regions. Texture lines inside one fill fail this test.
 * Orientation and neighboring-cell support reject isolated ridge responses. */
export function restoreStructuralSeams(labels: Int16Array, raw: Float32Array, closed: Float32Array, light: Float32Array, rgba: Uint8ClampedArray, sw: number, sh: number, width: number, height: number, colors: RGB[], retention: number, clarity: number, protectedMap: Float32Array, faces: SemanticFace[] = []) {
  if (retention <= 0 || clarity <= 0) return;
  const sx = sw / width, sy = sh / height, n = labels.length, ink = new Int16Array(n).fill(-1), response = new Float32Array(n), boundaries = new Uint8Array(n);
  const sample = (x: number, y: number) => {
    const xx = Math.max(0, Math.min(sw - 1, Math.round(x))), yy = Math.max(0, Math.min(sh - 1, Math.round(y))), out = [0, 0, 0]; let count = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const qx = xx + dx, qy = yy + dy; if (qx < 0 || qx >= sw || qy < 0 || qy >= sh) continue;
      const p = qy * sw + qx; if (!rgba[p * 4 + 3]) continue; count++; for (let d = 0; d < 3; d++) out[d] += raw[p * 3 + d];
    }
    return count ? out.map(v => v / count) : undefined;
  };
  for (let gy = 0; gy < height; gy++) for (let gx = 0; gx < width; gx++) {
    const k = gy * width + gx; if (labels[k] < 0) continue;
    let mass = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0, count = 0, protectedCell = false; const color = [0, 0, 0];
    for (let y = Math.floor(gy * sy); y < Math.min(sh, Math.ceil((gy + 1) * sy)); y++) for (let x = Math.floor(gx * sx); x < Math.min(sw, Math.ceil((gx + 1) * sx)); x++) {
      const p = y * sw + x; protectedCell ||= protectedMap[p] > .1;
      if (!rgba[p * 4 + 3]) continue;
      const weight = Math.max(0, closed[p] - light[p] - 7); if (!weight) continue;
      mass += weight; mx += x * weight; my += y * weight; xx += x * x * weight; yy += y * y * weight; xy += x * y * weight; count++;
      for (let d = 0; d < 3; d++) color[d] += raw[p * 3 + d] * weight;
    }
    if (protectedCell || count < sx * sy * .07 || !mass) continue;
    mx /= mass; my /= mass; xx = xx / mass - mx * mx; yy = yy / mass - my * my; xy = xy / mass - mx * my;
    const trace = xx + yy, spread = Math.hypot(xx - yy, 2 * xy);
    if (trace < .04 * sx * sy || spread / Math.max(.001, trace) < .4) continue;
    const theta = .5 * Math.atan2(2 * xy, xx - yy), nx = -Math.sin(theta) * sx * .6, ny = Math.cos(theta) * sy * .6;
    const a = sample(mx + nx, my + ny), b = sample(mx - nx, my - ny); if (!a || !b) continue;
    boundaries[k] = delta(a, 0, b) >= 180 ? 1 : 0;
    // Same-fill lines need a strong head-structure prior on detected portraits.
    // This avoids spending the tiny grid on every fabric fold below the face.
    if (!boundaries[k] && faces.length && !faces.some(face => {
      const jaw = face.points[2]; return jaw && (gy + .5) / height < jaw[1] && (gx + .5) / width > face.box[0] - face.box[2] * .2 && (gx + .5) / width < face.box[0] + face.box[2] * 1.2;
    })) continue;
    const sourceInk = color.map(v => v / mass), background = a.map((v, d) => (v + b[d]) / 2);
    if (background[0] - sourceInk[0] < (boundaries[k] ? 14 : 24)) continue;
    const amount = .45 + .5 * retention, target = sourceInk.map((v, d) => background[d] + (v - background[d]) * amount);
    ink[k] = nearest(target, 0, colors); response[k] = Math.min(1, count / (sx * sy) * 4) * clarity;
  }
  const original = labels.slice(), seen = new Uint8Array(n), valid = new Uint8Array(n), queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] || ink[start] < 0 || response[start] < .15) continue;
    let head = 0, tail = 1, boundaryCount = 0; queue[0] = start; seen[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width); boundaryCount += boundaries[p];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, q = yy * width + xx;
        if (xx < 0 || xx >= width || yy < 0 || yy >= height || seen[q] || ink[q] < 0 || response[q] < .15) continue;
        seen[q] = 1; queue[tail++] = q;
      }
    }
    if (tail >= (boundaryCount >= 2 ? 3 : 8)) for (let i = 0; i < tail; i++) valid[queue[i]] = 1;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x; if (!valid[p]) continue;
    let neighbors = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if ((!dx && !dy) || xx < 0 || xx >= width || yy < 0 || yy >= height) continue; if (ink[yy * width + xx] >= 0) neighbors++; }
    if (neighbors && colors[original[p]][0] - colors[ink[p]][0] > 5) labels[p] = ink[p];
  }
}
