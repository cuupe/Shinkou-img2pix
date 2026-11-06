import type { PixelSource, RGB, SemanticEye, SemanticFace, SemanticMouth } from './types';
import { labAt } from './slic';

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

/** Landmarks only delimit the search. Iris hue, position, extent and eyelid
 * color are measured from real source pixels inside the eye polygon. Uniform
 * fills, closed/monochrome eyes and insufficient chromatic evidence are skipped. */
export function sourceEyeDetails(source: PixelSource, points: SemanticFace['points']): SemanticEye[] {
  const result: SemanticEye[] = [];
  const quantile = (a: number[], q: number) => [...a].sort((a, b) => a - b)[Math.min(a.length - 1, Math.floor(a.length * q))];
  for (let index = 0; index < 2; index++) {
    const eye = points.slice(11 + index * 6, 17 + index * 6); if (eye.length !== 6 || eye.some(p => p[2] < .6)) continue;
    const polygon = [0, 1, 2, 5, 4, 3].map(k => [eye[k][0] * source.width, eye[k][1] * source.height]);
    const x0 = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[0])))), x1 = Math.min(source.width, Math.ceil(Math.max(...polygon.map(p => p[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1])))), y1 = Math.min(source.height, Math.ceil(Math.max(...polygon.map(p => p[1]))));
    if (x1 - x0 < 4 || y1 - y0 < 3) continue;
    const pixels: { x: number; y: number; rgb: RGB; l: number; a: number; b: number; hue: number; chroma: number }[] = [];
    const stride = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / 192));
    for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j]; if ((a[1] > y + .5) !== (b[1] > y + .5) && x + .5 < (b[0] - a[0]) * (y + .5 - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      const p = y * source.width + x; if (!inside || source.data[p * 4 + 3] < 240) continue;
      const rgb = [...source.data.slice(p * 4, p * 4 + 3)] as RGB, high = Math.max(...rgb), low = Math.min(...rgb), d = high - low;
      let hue = 0;
      if (d) hue = high === rgb[0] ? (rgb[1] - rgb[2]) / d : high === rgb[1] ? 2 + (rgb[2] - rgb[0]) / d : 4 + (rgb[0] - rgb[1]) / d;
      const lab = labAt(source.data, p);
      pixels.push({ x: x + .5, y: y + .5, rgb, l: lab[0], a: lab[1], b: lab[2], hue: ((hue * 60 + 360) % 360), chroma: d });
    }
    if (pixels.length < 12) continue;
    const dark = quantile(pixels.map(p => p.l), .12), bright = quantile(pixels.map(p => p.l), .88);
    if (bright - dark < 25) continue;
    // Landmark polygons may include small skin wedges. Compare against a
    // measured cheek strip so a monochrome eye cannot acquire a skin-colored
    // "iris" merely because those wedges are the only chromatic samples.
    const surround: RGB[] = [];
    for (let y = Math.ceil(y1 + .1 * (y1 - y0)); y < Math.min(source.height, y1 + .5 * (y1 - y0)); y += stride) for (let x = Math.ceil(x0 + .2 * (x1 - x0)); x < x1 - .2 * (x1 - x0); x += stride) {
      const p = y * source.width + x; if (source.data[p * 4 + 3] > 240) surround.push(labAt(source.data, p));
    }
    if (!surround.length) continue;
    const backdrop = [0, 1, 2].map(k => quantile(surround.map(p => p[k]), .5));
    const candidates = pixels.filter(p => p.l > dark + 12 && p.l < bright - 6 && p.chroma > 25 && p.y > y0 + .2 * (y1 - y0) && p.x > x0 + .15 * (x1 - x0) && p.x < x1 - .15 * (x1 - x0) && (p.l - backdrop[0]) ** 2 + (p.a - backdrop[1]) ** 2 + (p.b - backdrop[2]) ** 2 > 180);
    const bins = new Float64Array(24);
    for (const p of candidates) { const center = Math.exp(-(((p.x - (x0 + x1) / 2) / ((x1 - x0) * .5)) ** 2)); bins[Math.floor(p.hue / 15)] += center * p.chroma; }
    let best = -1, score = 0;
    for (let k = 0; k < 24; k++) { const v = bins[k] + .5 * (bins[(k + 23) % 24] + bins[(k + 1) % 24]); if (v > score) { best = k; score = v; } }
    if (best < 0) continue;
    const members = candidates.filter(p => { const bin = Math.floor(p.hue / 15), gap = Math.abs(bin - best); return Math.min(gap, 24 - gap) <= 1; });
    if (members.length < pixels.length * .035 || members.length < 4) continue;
    const medianRgb = (samples: typeof pixels): RGB => [0, 1, 2].map(k => Math.round(quantile(samples.map(p => p.rgb[k]), .5))) as RGB;
    const mid = quantile(members.map(p => p.l), .5), topInk = pixels.filter(p => p.y < y0 + .5 * (y1 - y0) && p.l <= dark + 8);
    if (topInk.length < 2) continue;
    const lower = members.filter(p => p.l <= mid), upper = members.filter(p => p.l >= mid);
    const whites = pixels.filter(p => p.l > 87 && Math.min(...p.rgb) > 210 && Math.max(...p.rgb) - Math.min(...p.rgb) < 28);
    if (quantile(members.map(p => p.y), .92) - quantile(members.map(p => p.y), .08) < (y1 - y0) * .2) continue;
    result.push({ index, iris: medianRgb(lower), irisLight: medianRgb(upper), ink: medianRgb(topInk), white: whites.length >= 3 ? medianRgb(whites) : undefined,
      position: [members.reduce((s, p) => s + p.x, 0) / members.length / source.width, members.reduce((s, p) => s + p.y, 0) / members.length / source.height],
      bounds: [quantile(members.map(p => p.x), .08) / source.width, quantile(members.map(p => p.y), .08) / source.height, quantile(members.map(p => p.x), .92) / source.width, quantile(members.map(p => p.y), .92) / source.height] });
  }
  return result;
}

/** Measure a narrow closed-mouth stroke before area sampling can dilute it.
 * Dense/open mouth interiors, weak contrast and unsupported landmarks fail. */
export function sourceMouthDetail(source: PixelSource, points: SemanticFace['points']): SemanticMouth | undefined {
  const mouth = points.slice(24, 28); if (mouth.length !== 4 || mouth.some(p => p[2] < .65)) return;
  const left = Math.min(...mouth.map(p => p[0])) * source.width, right = Math.max(...mouth.map(p => p[0])) * source.width;
  const top = Math.min(...mouth.map(p => p[1])) * source.height, bottom = Math.max(...mouth.map(p => p[1])) * source.height, span = right - left;
  if (span < 6 || bottom - top > span * .4) return;
  const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(source.width - 1, Math.ceil(right));
  const y0 = Math.max(0, Math.floor(top - span * .16)), y1 = Math.min(source.height - 1, Math.ceil(bottom + span * .16));
  const samples: { x: number; y: number; l: number; rgb: RGB }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const p = y * source.width + x; if (source.data[p * 4 + 3] > 240) samples.push({ x, y, l: labAt(source.data, p)[0], rgb: [...source.data.slice(p * 4, p * 4 + 3)] as RGB }); }
  if (samples.length < 12) return;
  const median = (a: number[]) => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
  const background = [0, 1, 2].map(k => median(samples.map(p => p.rgb[k]))) as RGB, backgroundL = median(samples.map(p => p.l));
  const ink = samples.filter(p => p.l < backgroundL - 20);
  if (ink.length < samples.length * .012 || ink.length > samples.length * .32) return;
  const path: [number, number][] = [];
  for (let x = x0; x <= x1; x++) { let mass = 0, sum = 0; for (const p of ink) if (p.x === x) { const weight = backgroundL - p.l; mass += weight; sum += p.y * weight; } if (mass) path.push([(x + .5) / source.width, (sum / mass + .5) / source.height]); }
  if (path.length < span * .3) return;
  // Bound cached geometry to a small polyline, retaining the measured ends.
  const compact = path.filter((_, i) => i === 0 || i === path.length - 1 || i % Math.max(1, Math.floor(path.length / 16)) === 0);
  return { path: compact, ink: [0, 1, 2].map(k => median(ink.map(p => p.rgb[k]))) as RGB, background, bounds: [x0 / source.width, y0 / source.height, (x1 + 1) / source.width, (y1 + 1) / source.height] };
}
