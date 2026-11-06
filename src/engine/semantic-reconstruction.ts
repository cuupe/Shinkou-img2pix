import { labAt } from './slic';
import type { RGB, SemanticFace, Settings } from './types';

const clamp = (v: number) => Math.max(0, Math.min(255, v));
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
function nearest(lab: ArrayLike<number>, colors: RGB[]) { let best = 0, error = Infinity; colors.forEach((c, k) => { const d = distance(lab, c); if (d < error) { error = d; best = k; } }); return best; }
export function adjustedSemanticColor(rgb: RGB, settings: Settings): RGB {
  const luma = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722, contrast = (1 + settings.contrast / 100) ** 2;
  return rgb.map(v => Math.round(clamp((luma + (v - luma) * (1 + settings.saturation / 100) - 127.5) * contrast + 127.5 + settings.brightness * 2.55))) as RGB;
}
function colorLab(rgb: RGB, settings: Settings): RGB { return labAt(new Uint8ClampedArray([...adjustedSemanticColor(rgb, settings), 255]), 0); }

/** Neural localization + source color evidence, followed by joint discrete
 * layout. No trained pixel-style model or fixed eye sprite is used. Each eye
 * is reclassified from its own measured polygon at nine sub-cell phases. */
export function refineSemanticGlyphs(labels: Int16Array, raw: Float32Array, sw: number, sh: number, width: number, height: number, colors: RGB[], faces: SemanticFace[], settings: Settings) {
  const strength = Math.max(0, Math.min(1, settings.semanticDetail / 100));
  if (strength < .25 || (settings.pixelClarity ?? 70) <= 0) return;
  const put = (p: number, color: number) => { if (p >= 0 && p < labels.length && labels[p] >= 0) labels[p] = color; };
  for (const face of faces) for (const detail of face.eyes ?? []) {
    const points = face.points.slice(11 + detail.index * 6, 17 + detail.index * 6); if (points.length !== 6 || points.some(p => p[2] < .6)) continue;
    const left = Math.min(...points.map(p => p[0])), right = Math.max(...points.map(p => p[0])), top = Math.min(...points.map(p => p[1])), bottom = Math.max(...points.map(p => p[1]));
    if ((right - left) * width < 2 || (bottom - top) * height < 1.4) continue;
    const polygon = [0, 1, 2, 5, 4, 3].map(k => points[k]);
    const inside = (x: number, y: number) => { let yes = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i], b = polygon[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes; } return yes; };
    const ink = colorLab(detail.ink, settings), iris = colorLab(detail.iris, settings), lightIris = colorLab(detail.irisLight, settings);
    const highlightIndex = (face.highlights ?? []).findIndex(([x, y]) => x >= left && x <= right && y >= top && y <= bottom);
    const whiteRgb = (highlightIndex >= 0 ? face.highlightColors?.[highlightIndex] : undefined) ?? detail.white;
    const white = whiteRgb ? colorLab(whiteRgb, settings) : [95, 0, 0];
    if (white[0] - ink[0] < 22 || iris[0] - ink[0] < 6) continue;
    const targets = [ink, iris, lightIris, white], mapped = targets.map(c => nearest(c, colors));
    const x0 = Math.max(0, Math.floor(left * width)), x1 = Math.min(width, Math.ceil(right * width));
    const y0 = Math.max(0, Math.floor(top * height)), y1 = Math.min(height, Math.ceil(bottom * height));
    const samples = 8, sampleCount = samples * samples;
    type Cell = { p: number; type: number; support: number[]; coverage: number };
    let best: Cell[] = [], bestScore = -Infinity;
    for (const dy of [-.25, 0, .25]) for (const dx of [-.25, 0, .25]) {
      const cells: Cell[] = []; let score = -.04 * (Math.abs(dx) + Math.abs(dy)), irisCells = 0, inkCells = 0;
      for (let gy = y0; gy < y1; gy++) for (let gx = x0; gx < x1; gx++) {
        const support = [0, 0, 0, 0]; let covered = 0;
        for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
          const nx = (gx + (sx + .5) / samples + dx) / width, ny = (gy + (sy + .5) / samples + dy) / height;
          if (!inside(nx, ny)) continue;
          const x = Math.max(0, Math.min(sw - 1, Math.floor(nx * sw))), y = Math.max(0, Math.min(sh - 1, Math.floor(ny * sh))), p = (y * sw + x) * 3;
          const c = [raw[p], raw[p + 1], raw[p + 2]]; covered++;
          let type: number;
          if (c[0] < ink[0] + 12) type = 0;
          else if (whiteRgb && c[0] > 80 && Math.hypot(c[1], c[2]) < 23) type = 3;
          else {
            const chroma = (c[1] - iris[1]) ** 2 + (c[2] - iris[2]) ** 2;
            if (chroma > 450 || c[0] > Math.max(iris[0], lightIris[0]) + 18) continue;
            type = distance(c, iris) <= distance(c, lightIris) ? 1 : 2;
          }
          support[type]++;
        }
        if (covered < sampleCount * .17) continue;
        const weights = [1.12, 1.4, 1.4, 1], type = support.reduce((best, value, k) => value * weights[k] > support[best] * weights[best] ? k : best, 0);
        if (support[type] < sampleCount * .12) continue;
        score += support[type] * weights[type] / sampleCount;
        if (type === 1 || type === 2) irisCells++; if (type === 0) inkCells++;
        cells.push({ p: gy * width + gx, type, support, coverage: covered / sampleCount });
      }
      if (!irisCells) score -= 2; if (!inkCells) score -= .8;
      if (score > bestScore) { bestScore = score; best = cells; }
    }
    const highlights = (face.highlights ?? []).filter(([x, y]) => x >= left && x <= right && y >= top && y <= bottom);
    const protectedPixels = new Set(highlights.map(([x, y]) => Math.floor(y * height) * width + Math.floor(x * width)));
    for (const cell of best) {
      const previous = labels[cell.p]; if (previous < 0) continue;
      const amount = .5 + .5 * strength, target = targets[cell.type].map((v, d) => colors[previous][d] + (v - colors[previous][d]) * amount);
      put(cell.p, nearest(target, colors));
    }
    // Reserve one source-supported iris cell jointly with the actual highlight.
    // In tiny eyes these can quantize into one cell; the nearest supported free
    // cell is preferred rather than losing either feature or stamping a sprite.
    const irisCandidates = best.filter(c => !protectedPixels.has(c.p) && (c.support[1] + c.support[2]) / sampleCount > .12);
    irisCandidates.sort((a, b) => {
      const cost = (c: Cell) => ((c.p % width + .5) / width - detail.position[0]) ** 2 + ((Math.floor(c.p / width) + .5) / height - detail.position[1]) ** 2;
      return cost(a) - cost(b);
    });
    if (irisCandidates.length) put(irisCandidates[0].p, mapped[1]);
    for (const p of protectedPixels) put(p, mapped[3]);
  }
  for (const face of faces) {
    const mouth = face.mouth; if (!mouth || mouth.path.length < 2) continue;
    const span = (mouth.path[mouth.path.length - 1][0] - mouth.path[0][0]) * width; if (span < 1.3) continue;
    const background = colorLab(mouth.background, settings), ink = colorLab(mouth.ink, settings), amount = .55 + .35 * strength * Math.min(1, (settings.pixelClarity ?? 70) / 100);
    if (background[0] - ink[0] < 20) continue;
    const base = nearest(background, colors), color = nearest(ink.map((v, d) => background[d] + (v - background[d]) * amount), colors);
    if (colors[base][0] - colors[color][0] < 8) continue;
    const [left, top, right, bottom] = mouth.bounds;
    for (let y = Math.max(0, Math.floor(top * height)); y < Math.min(height, Math.ceil(bottom * height)); y++) for (let x = Math.max(0, Math.floor(left * width)); x < Math.min(width, Math.ceil(right * width)); x++) put(y * width + x, base);
    const length = Math.max(1, Math.round(span)), center = (mouth.path[0][0] + mouth.path[mouth.path.length - 1][0]) * width / 2, gx = Math.round(center - length / 2);
    const ys: number[] = [];
    let cursor = 0;
    for (let i = 0; i < length; i++) {
      const x = mouth.path[0][0] + (mouth.path[mouth.path.length - 1][0] - mouth.path[0][0]) * (length > 1 ? i / (length - 1) : .5);
      while (cursor + 1 < mouth.path.length && mouth.path[cursor + 1][0] < x) cursor++;
      const a = mouth.path[cursor], b = mouth.path[Math.min(mouth.path.length - 1, cursor + 1)], t = a[0] === b[0] ? 0 : (x - a[0]) / (b[0] - a[0]); ys.push((a[1] * (1 - t) + b[1] * t) * height);
    }
    const bottomY = Math.max(...ys), row = Math.round(bottomY - .5);
    for (let i = 0; i < length; i++) { const x = gx + i, y = row + Math.round(ys[i] - bottomY); if (x >= 0 && x < width && y >= 0 && y < height) put(y * width + x, color); }
  }
}
