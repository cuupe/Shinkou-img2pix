import { PALETTES } from './palettes';
import type { PixelResult, PixelSource, RGB, Settings } from './types';
import { cleanRegions, detectFeatures, mapRegions } from './structure';

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

interface ColorPoint { rgb: RGB; lab: RGB; weight: number }
function adaptivePalette(data: Uint8ClampedArray, count: number, importance?: Float32Array): RGB[] {
  const bins = new Map<number, number[]>();
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const key = (data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | data[i + 2] >> 3;
    const weight = 1 + (importance?.[i / 4] ?? 0) * 8;
    const bin = bins.get(key);
    if (bin) { bin[0] += data[i] * weight; bin[1] += data[i + 1] * weight; bin[2] += data[i + 2] * weight; bin[3] += weight; }
    else bins.set(key, [data[i] * weight, data[i + 1] * weight, data[i + 2] * weight, weight]);
  }
  const points: ColorPoint[] = Array.from(bins.values(), b => {
    const rgb: RGB = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    return { rgb, lab: oklab(rgb), weight: b[3] };
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

export function pixelate(source: PixelSource, settings: Settings): PixelResult {
  const start = performance.now();
  if (!source.width || !source.height || source.data.length !== source.width * source.height * 4) throw new Error('图片数据不完整');
  const size = Math.max(16, Math.min(512, Math.round(settings.size)));
  const { width, height } = dimensions(source.width, source.height, size);
  if (settings.method === 'structure') {
    // Analyze before the final reduction, at up to four samples per output cell.
    // Palette extraction and feature detection see fine lines before they are lost.
    const workWidth = Math.min(source.width, width * 4), workHeight = Math.min(source.height, height * 4);
    const working = areaSample(source, workWidth, workHeight, settings.transparent);
    adjust(working, workWidth, workHeight, { ...settings, detail: false });
    const features = detectFeatures(working, workWidth, workHeight);
    const palette = settings.palette === 'adaptive'
      ? adaptivePalette(working, Math.max(2, Math.min(256, settings.colors)), features.importance)
      : PALETTES[settings.palette];
    quantize(working, workWidth, workHeight, palette, { ...settings, dither: 'none' });
    const mapped = mapRegions(working, workWidth, workHeight, width, height, palette, features, settings.lineProtection);
    cleanRegions(mapped, width, height, palette, settings.cleanup);
    return { data: mapped.data, width, height, palette, duration: performance.now() - start };
  }
  const data = areaSample(source, width, height, settings.transparent);
  adjust(data, width, height, settings);
  const palette = settings.palette === 'adaptive' ? adaptivePalette(data, Math.max(2, Math.min(256, settings.colors))) : PALETTES[settings.palette];
  quantize(data, width, height, palette, settings);
  return { data, width, height, palette, duration: performance.now() - start };
}
