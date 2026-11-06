import { oklab, pixelate } from './pixelate';
import { DEFAULT_SETTINGS } from './types';
import type { PixelResult, PixelSource, RGB } from './types';

interface ColorMass { rgb: RGB; lab: RGB; weight: number }
export interface RedrawColorReference { palette: RGB[]; all: ColorMass[]; foreground: ColorMass[]; background: ColorMass[] }
const keyAt = (data: Uint8ClampedArray, p: number) => data[p] * 65536 + data[p + 1] * 256 + data[p + 2];
const fromKey = (key: number): RGB => [key >> 16, (key >> 8) & 255, key & 255];
const distance = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Only corner-connected, near-uniform background. Interior eye whites are not
 * classified by color alone; no semantic segmentation or coordinate warp is used. */
function backgroundMask(source: PixelSource) {
  const { width: w, height: h, data } = source, mask = new Uint8Array(w * h);
  const corners = [...new Set([0, w - 1, (h - 1) * w, w * h - 1])];
  const labs = new Map<number, RGB>();
  const labAt = (p: number) => { const key = keyAt(data, p * 4); if (!labs.has(key)) labs.set(key, oklab(fromKey(key))); return labs.get(key)!; };
  let seed = -1, best = -Infinity;
  for (const p of corners) {
    if (!data[p * 4 + 3]) continue;
    const lab = labAt(p), support = corners.filter(q => data[q * 4 + 3] && distance(lab, labAt(q)) < .035 ** 2).length;
    if (support < Math.min(2, corners.length)) continue;
    const score = support + lab[0] * .15 - Math.hypot(lab[1], lab[2]) * .1;
    if (score > best) { best = score; seed = p; }
  }
  if (seed < 0) return mask;
  const color = labAt(seed), queue = new Int32Array(w * h); let head = 0, tail = 0;
  const put = (p: number) => {
    if (mask[p] || !data[p * 4 + 3] || distance(color, labAt(p)) > .045 ** 2) return;
    mask[p] = 1; queue[tail++] = p;
  };
  corners.forEach(put);
  while (head < tail) {
    const p = queue[head++], x = p % w;
    if (x) put(p - 1); if (x + 1 < w) put(p + 1);
    if (p >= w) put(p - w); if (p + w < w * h) put(p + w);
  }
  return mask;
}

function histogram(source: PixelSource, mask?: Uint8Array, background = false): ColorMass[] {
  const counts = new Map<number, number>(); let total = 0;
  for (let p = 0; p < source.width * source.height; p++) {
    if (!source.data[p * 4 + 3] || (mask && !!mask[p] !== background)) continue;
    const key = keyAt(source.data, p * 4); counts.set(key, (counts.get(key) ?? 0) + 1); total++;
  }
  return [...counts].map(([key, count]) => { const rgb = fromKey(key); return { rgb, lab: oklab(rgb), weight: count / total }; });
}

/** Cached per original image/color budget, never fitted to a generated image. */
export function prepareRedrawColors(source: PixelSource, colors: number): RedrawColorReference {
  const sampled = pixelate(source, { ...DEFAULT_SETTINGS, method: 'sample', backend: 'cpu', size: 128, colors, detail: false, transparent: false, transitionRetention: 100 });
  const mask = backgroundMask(sampled), all = histogram(sampled);
  return { palette: all.map(c => c.rgb), all, foreground: histogram(sampled, mask), background: histogram(sampled, mask, true) };
}

/** Entropic optimal transport balances source color proportions, rather than
 * assigning every dark red cell to the nearest burgundy outline color. */
function colorCorrespondence(generated: ColorMass[], reference: ColorMass[], preserveContrast = true) {
  const n = generated.length, m = reference.length, mapping = new Map<number, RGB>();
  if (!n || !m) return mapping;
  const kernel = new Float64Array(n * m), u = new Float64Array(n).fill(1), v = new Float64Array(m).fill(1);
  for (let i = 0; i < n; i++) {
    const costs = reference.map(c => distance(generated[i].lab, c.lab)), minimum = Math.min(...costs);
    for (let j = 0; j < m; j++) kernel[i * m + j] = Math.exp(Math.max(-80, -(costs[j] - minimum) / .006));
  }
  for (let iteration = 0; iteration < 128; iteration++) {
    for (let i = 0; i < n; i++) { let sum = 0; for (let j = 0; j < m; j++) sum += kernel[i * m + j] * v[j]; u[i] = generated[i].weight / Math.max(1e-100, sum); }
    for (let j = 0; j < m; j++) { let sum = 0; for (let i = 0; i < n; i++) sum += kernel[i * m + j] * u[i]; v[j] = reference[j].weight / Math.max(1e-100, sum); }
  }
  for (let i = 0; i < n; i++) {
    const mean: RGB = [0, 0, 0]; let total = 0;
    for (let j = 0; j < m; j++) { const weight = kernel[i * m + j] * v[j]; total += weight; for (let k = 0; k < 3; k++) mean[k] += reference[j].lab[k] * weight; }
    if (!(total > 0) || !Number.isFinite(total)) continue;
    for (let k = 0; k < 3; k++) mean[k] /= total;
    // A wider generated eyelid must not become gray simply because the original
    // has fewer ink pixels. Keep supported deep ink and bright highlights legible.
    const protectedColors = preserveContrast && generated[i].lab[0] < .35 ? reference.filter(c => c.lab[0] < .45)
      : preserveContrast && generated[i].lab[0] > .92 ? reference.filter(c => c.lab[0] > .9) : [];
    const candidates = protectedColors.length ? protectedColors : reference;
    const target = protectedColors.length ? generated[i].lab : mean;
    let best = candidates[0]; for (const color of candidates) if (distance(color.lab, target) < distance(best.lab, target)) best = color;
    const rgb = generated[i].rgb; mapping.set(rgb[0] * 65536 + rgb[1] * 256 + rgb[2], best.rgb);
  }
  return mapping;
}

const linear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const srgb = (v: number) => Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));

export function retainRedrawColors(result: PixelResult, reference: RedrawColorReference, retention: number, colors: number): PixelResult {
  const amount = Math.max(0, Math.min(1, Number.isFinite(retention) ? retention / 100 : 0));
  if (!amount || !reference.all.length) return result;
  const start = performance.now(), mask = backgroundMask(result);
  const split = reference.background.length > 0 && mask.some(Boolean);
  const full = split ? undefined : colorCorrespondence(histogram(result), reference.all);
  const foreground = full ?? colorCorrespondence(histogram(result, mask), reference.foreground.length ? reference.foreground : reference.all);
  const background = full ?? colorCorrespondence(histogram(result, mask, true), reference.background, false);
  const data = result.data.slice();
  for (let p = 0; p < result.width * result.height; p++) {
    const i = p * 4; if (!data[i + 3]) continue;
    const rgb = (split && mask[p] ? background : foreground).get(keyAt(result.data, i));
    if (!rgb) continue;
    for (let k = 0; k < 3; k++) data[i + k] = amount === 1 ? rgb[k] : srgb(linear(result.data[i + k] / 255) * (1 - amount) + linear(rgb[k] / 255) * amount);
  }
  // 100% uses original palette entries exactly. Intermediate strengths may mix
  // foreground/background mappings, so re-quantize to retain the color budget.
  const corrected = amount === 1 ? { ...result, data, palette: histogram({ ...result, data }).map(c => c.rgb) }
    : pixelate({ ...result, data }, { ...DEFAULT_SETTINGS, backend: 'cpu', method: 'sample', size: Math.max(result.width, result.height), colors, detail: false, transitionRetention: 100 });
  return { ...corrected, duration: result.duration + performance.now() - start, execution: { ...result.execution, timings: { ...result.execution.timings, sourceColors: performance.now() - start } } };
}
