import { PALETTES } from './palettes';
import type { PixelResult, PixelSource, RGB, Settings } from './types';
import { cleanRegions, detectFeatures, mapRegions } from './structure';
import { regularizeBoundaries } from './boundaries';
import { resolveTransitions } from './transitions';
import type { FeatureMap } from './structure';
import { cleanSuperpixels } from './slic';

const clamp = (n: number, max = 255) => Math.max(0, Math.min(max, n));
const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const srgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => linear(i / 255));

// Oklab distances preserve perceived brightness and hue better than RGB distance.
export function oklab([red, green, blue]: RGB): RGB {
  const r = LINEAR[Math.round(clamp(red))], g = LINEAR[Math.round(clamp(green))], b = LINEAR[Math.round(clamp(blue))];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function dimensions(width: number, height: number, size: number) {
  const scale = Math.min(1, size / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Exact area integration in linear light; premultiplied alpha avoids dark fringes.
function areaSample(source: PixelSource, width: number, height: number, transparent: boolean) {
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = source.width / width, sy = source.height / height;
  for (let y = 0; y < height; y++) {
    const top = y * sy, bottom = (y + 1) * sy;
    for (let x = 0; x < width; x++) {
      const left = x * sx, right = (x + 1) * sx;
      let r = 0, g = 0, b = 0, alpha = 0;
      for (let yy = Math.floor(top); yy < Math.ceil(bottom); yy++) {
        const wy = Math.min(bottom, yy + 1) - Math.max(top, yy);
        for (let xx = Math.floor(left); xx < Math.ceil(right); xx++) {
          const weight = wy * (Math.min(right, xx + 1) - Math.max(left, xx));
          const i = (Math.min(yy, source.height - 1) * source.width + Math.min(xx, source.width - 1)) * 4;
          const a = source.data[i + 3] / 255;
          if (transparent) {
            r += LINEAR[source.data[i]] * a * weight;
            g += LINEAR[source.data[i + 1]] * a * weight;
            b += LINEAR[source.data[i + 2]] * a * weight;
            alpha += a * weight;
          } else {
            r += (LINEAR[source.data[i]] * a + 1 - a) * weight;
            g += (LINEAR[source.data[i + 1]] * a + 1 - a) * weight;
            b += (LINEAR[source.data[i + 2]] * a + 1 - a) * weight;
            alpha += weight;
          }
        }
      }
      const i = (y * width + x) * 4;
      if (alpha > 0) {
        out[i] = srgb(r / alpha); out[i + 1] = srgb(g / alpha); out[i + 2] = srgb(b / alpha);
      }
      out[i + 3] = alpha / (sx * sy) >= 0.5 ? 255 : 0;
    }
  }
  return out;
}

function adjust(data: Uint8ClampedArray, w: number, h: number, settings: Settings) {
  const original = settings.detail ? data.slice() : data;
  const contrast = (1 + settings.contrast / 100) ** 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!data[i + 3]) continue;
    const c: RGB = [original[i], original[i + 1], original[i + 2]];
    if (settings.detail) for (let k = 0; k < 3; k++) {
      let total = 0, count = 0;
      for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const j = (yy * w + xx) * 4;
        if (original[j + 3]) { total += original[j + k]; count++; }
      }
      if (count) c[k] = clamp(c[k] + (c[k] - total / count) * 0.45);
    }
    const luma = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    for (let k = 0; k < 3; k++) data[i + k] = clamp(((luma + (c[k] - luma) * (1 + settings.saturation / 100)) - 127.5) * contrast + 127.5 + settings.brightness * 2.55);
  }
}

interface ColorPoint { rgb: RGB; lab: RGB; weight: number; sample: RGB }
function adaptivePalette(data: Uint8ClampedArray, count: number, importance?: Float32Array, coherence?: Float32Array, transitionRetention = 100): RGB[] {
  const bins = new Map<number, number[]>();
  const keep = Math.max(0, Math.min(1, transitionRetention / 100));
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const key = (data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | data[i + 2] >> 3;
    // Flat interiors and coherent lines train the palette; antialiased mixtures
    // must not receive more palette capacity just because their contrast is high.
    const stable = coherence?.[i / 4] ?? 1;
    const stableWeight = keep * keep + (1 - keep * keep) * stable ** (4 - 2 * keep);
    const weight = (.015 + .985 * stableWeight) * (1 + (importance?.[i / 4] ?? 0) * 4);
    const bin = bins.get(key);
    if (bin) {
      bin[0] += data[i] * weight; bin[1] += data[i + 1] * weight; bin[2] += data[i + 2] * weight; bin[3] += weight;
      if (weight > bin[4]) { bin[4] = weight; bin[5] = data[i]; bin[6] = data[i + 1]; bin[7] = data[i + 2]; }
    }
    else bins.set(key, [data[i] * weight, data[i + 1] * weight, data[i + 2] * weight, weight, weight, data[i], data[i + 1], data[i + 2]]);
  }
  const points: ColorPoint[] = Array.from(bins.values(), b => {
    const rgb: RGB = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    return { rgb, lab: oklab(rgb), weight: b[3], sample: [b[5], b[6], b[7]] };
  });
  if (!points.length) return [];
  function box(points: ColorPoint[]) {
    const weight = points.reduce((sum, p) => sum + p.weight, 0);
    const mean = [0, 1, 2].map(k => points.reduce((sum, p) => sum + p.lab[k] * p.weight, 0) / weight);
    const variance = [0, 1, 2].map(k => points.reduce((sum, p) => sum + (p.lab[k] - mean[k]) ** 2 * p.weight, 0));
    const axis = variance.indexOf(Math.max(...variance));
    return { points, weight, axis, score: points.length > 1 ? variance[axis] : -1 };
  }
  const boxes = [box(points)];
  while (boxes.length < count) {
    boxes.sort((a, b) => b.score - a.score);
    const current = boxes[0];
    if (current.score < 0) break;
    current.points.sort((a, b) => a.lab[current.axis] - b.lab[current.axis]);
    let sum = 0, split = 1;
    for (; split < current.points.length; split++) { sum += current.points[split - 1].weight; if (sum >= current.weight / 2) break; }
    split = Math.min(split, current.points.length - 1);
    boxes.splice(0, 1, box(current.points.slice(0, split)), box(current.points.slice(split)));
  }
  let palette: RGB[] = boxes.map(b => [0, 1, 2].map(k => Math.round(b.points.reduce((sum, p) => sum + p.rgb[k] * p.weight, 0) / b.weight)) as RGB);
  // Weighted Lloyd refinement reduces median-cut banding without changing the color budget.
  for (let iter = 0; iter < 2; iter++) {
    const labs = palette.map(oklab);
    const sums = palette.map(() => [0, 0, 0, 0]);
    for (const p of points) {
      const index = nearest(p.lab, labs), sum = sums[index];
      for (let k = 0; k < 3; k++) sum[k] += p.rgb[k] * p.weight;
      sum[3] += p.weight;
    }
    palette = sums.map((s, i) => s[3] ? [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])] : palette[i]);
  }
  if (coherence && palette.length > 1) {
    if (transitionRetention <= 0) {
      // At the cleanest setting use actual input representatives, not new colors
      // invented by cluster means. Retain the same user-specified palette budget.
      const labs = palette.map(oklab), maxima = palette.map(() => 0);
      const assignments = points.map(p => nearest(p.lab, labs));
      points.forEach((p, i) => { const k = assignments[i]; maxima[k] = Math.max(maxima[k], p.weight); });
      const costs = palette.map(() => Infinity), representatives = palette.slice();
      points.forEach((p, i) => {
        const k = assignments[i]; if (p.weight < maxima[k] * .08) return;
        const cost = p.lab.reduce((sum, v, channel) => sum + (v - labs[k][channel]) ** 2, 0);
        if (cost < costs[k]) { costs[k] = cost; representatives[k] = p.sample; }
      });
      palette = representatives;
    }
    // True black ink and near-white highlights must not be averaged into a large
    // neighboring brown/mint cluster. Only reserve colors actually in the input.
    for (const light of [false, true]) {
      const extremes = points.filter(p => light ? Math.min(...p.rgb) >= 245 : Math.max(...p.rgb) <= 12);
      const weight = extremes.reduce((sum, p) => sum + p.weight, 0);
      if (weight < 3) continue;
      const rgb = transitionRetention <= 0
        ? extremes.reduce((best, p) => p.weight > best.weight ? p : best).sample
        : [0, 1, 2].map(k => Math.round(extremes.reduce((sum, p) => sum + p.rgb[k] * p.weight, 0) / weight)) as RGB;
      palette[nearest(oklab(rgb), palette.map(oklab))] = rgb;
    }
  }
  return palette.sort((a, b) => oklab(a)[0] - oklab(b)[0]);
}

function nearest(color: RGB, palette: RGB[]) {
  let best = 0, distance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (color[0] - p[0]) ** 2 + (color[1] - p[1]) ** 2 + (color[2] - p[2]) ** 2;
    if (d < distance) { distance = d; best = i; }
  }
  return best;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function quantize(data: Uint8ClampedArray, w: number, h: number, palette: RGB[], settings: Settings) {
  if (!palette.length) return;
  const labs = palette.map(oklab);
  const cache = new Map<number, number>();
  const working = Float32Array.from(data);
  const strength = settings.ditherAmount / 100;
  for (let y = 0; y < h; y++) {
    const direction = settings.dither === 'floyd' && y % 2 ? -1 : 1;
    for (let step = 0; step < w; step++) {
      const x = direction === 1 ? step : w - 1 - step, i = (y * w + x) * 4;
      if (!data[i + 3]) { data[i] = data[i + 1] = data[i + 2] = 0; continue; }
      const offset = settings.dither === 'ordered' ? (BAYER[(y % 4) * 4 + x % 4] / 16 - 0.46875) * 90 * strength : 0;
      const c: RGB = [0, 1, 2].map(k => Math.round(clamp(working[i + k] + offset))) as RGB;
      const key = c[0] << 16 | c[1] << 8 | c[2];
      let index = cache.get(key);
      if (index === undefined) { index = nearest(oklab(c), labs); cache.set(key, index); }
      const color = palette[index];
      for (let k = 0; k < 3; k++) data[i + k] = color[k];
      if (settings.dither === 'floyd') {
        for (const [dx, dy, factor] of [[direction, 0, 7 / 16], [-direction, 1, 3 / 16], [0, 1, 5 / 16], [direction, 1, 1 / 16]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) continue;
          const j = (yy * w + xx) * 4;
          if (!data[j + 3]) continue;
          for (let k = 0; k < 3; k++) working[j + k] += (c[k] - color[k]) * factor * strength;
        }
      }
    }
  }
}

export interface PreparedImage { data: Uint8ClampedArray; features?: FeatureMap; aiImportance?: Float32Array }
export type PipelineStep =
  | { kind: 'prepare'; source: PixelSource; width: number; height: number; settings: Settings; withFeatures: boolean }
  | { kind: 'quantize'; data: Uint8ClampedArray; width: number; height: number; palette: RGB[]; settings: Settings };
export type PipelineOutput = PreparedImage | undefined;

export function executeCpuStep(step: PipelineStep): PipelineOutput {
  if (step.kind === 'quantize') {
    quantize(step.data, step.width, step.height, step.palette, step.settings); return;
  }
  const data = areaSample(step.source, step.width, step.height, step.settings.transparent);
  adjust(data, step.width, step.height, step.settings);
  return { data, features: step.withFeatures ? detectFeatures(data, step.width, step.height) : undefined };
}

/** Both backends drive this same pipeline; only independent per-pixel stages differ. */
function* pipeline(source: PixelSource, settings: Settings): Generator<PipelineStep, PixelResult, PipelineOutput> {
  const start = performance.now();
  const timings: Record<string, number> = {};
  const measure = <T,>(name: string, operation: () => T): T => { const t = performance.now(); const out = operation(); timings[name] = performance.now() - t; return out; };
  const result = (data: Uint8ClampedArray, width: number, height: number, palette: RGB[]): PixelResult => ({ data, width, height, palette, duration: performance.now() - start, execution: { backend: 'cpu', gpuStages: [], timings } });
  if (!source.width || !source.height || source.data.length !== source.width * source.height * 4) throw new Error('图片数据不完整');
  const size = Math.max(16, Math.min(512, Math.round(settings.size)));
  const { width, height } = dimensions(source.width, source.height, size);
  if (settings.method === 'structure') {
    // Keep up to eight samples per cell: a 2–3 source-pixel ink line must not
    // already have turned gray before transition ownership is analyzed.
    // The 2048 edge cap keeps the analysis buffer at the previous memory ceiling.
    const analysisScale = Math.min(8, 2048 / Math.max(width, height));
    const workWidth = Math.min(source.width, Math.round(width * analysisScale)), workHeight = Math.min(source.height, Math.round(height * analysisScale));
    let t = performance.now();
    const prepared = (yield { kind: 'prepare', source, width: workWidth, height: workHeight, settings: { ...settings, detail: false }, withFeatures: true })!;
    timings.prepare = performance.now() - t;
    const working = prepared.data, features = prepared.features!;
    const palette = measure('palette', () => settings.palette === 'adaptive'
      ? adaptivePalette(working, Math.max(2, Math.min(256, settings.colors)), features.importance, features.coherence, settings.transitionRetention ?? 25)
      : PALETTES[settings.palette]);
    // Neural guidance changes ownership/protection, never the extracted palette.
    if (prepared.aiImportance) features.importance = prepared.aiImportance;
    const originalWorking = working.slice();
    t = performance.now(); yield { kind: 'quantize', data: working, width: workWidth, height: workHeight, palette, settings: { ...settings, dither: 'none' } };
    timings.quantize = performance.now() - t;
    measure('transitions', () => resolveTransitions(originalWorking, working, workWidth, workHeight, palette, features, settings.transitionRetention ?? 25));
    if (settings.regionCleanup > 0) measure('regions', () => cleanSuperpixels(originalWorking, working, workWidth, workHeight, palette, features, settings.regionCleanup, Math.max(6, Math.min(24, Math.round(Math.min(workWidth / width, workHeight / height) * 2)))));
    const mapped = measure('mapping', () => mapRegions(working, workWidth, workHeight, width, height, palette, features, settings.lineProtection));
    measure('contours', () => { regularizeBoundaries(mapped, width, height, palette, settings.edgeSmoothing ?? 65); cleanRegions(mapped, width, height, palette, settings.cleanup); });
    return result(mapped.data, width, height, palette);
  }
  let t = performance.now();
  const prepared = (yield { kind: 'prepare', source, width, height, settings, withFeatures: false })!;
  timings.prepare = performance.now() - t;
  const data = prepared.data;
  const palette = measure('palette', () => settings.palette === 'adaptive' ? adaptivePalette(data, Math.max(2, Math.min(256, settings.colors))) : PALETTES[settings.palette]);
  t = performance.now(); yield { kind: 'quantize', data, width, height, palette, settings }; timings.quantize = performance.now() - t;
  return result(data, width, height, palette);
}

export function pixelate(source: PixelSource, settings: Settings): PixelResult {
  const task = pipeline(source, settings); let step = task.next();
  while (!step.done) step = task.next(executeCpuStep(step.value));
  return step.value;
}

export async function pixelateWithExecutor(source: PixelSource, settings: Settings, execute: (step: PipelineStep) => Promise<PipelineOutput>): Promise<PixelResult> {
  const task = pipeline(source, settings); let step = task.next();
  while (!step.done) step = task.next(await execute(step.value));
  return step.value;
}
