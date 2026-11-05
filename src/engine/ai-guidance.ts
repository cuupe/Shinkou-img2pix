import type { FeatureMap } from './structure';
import type { PixelSource } from './types';

export interface EdgeMap {
  data: Float32Array; width: number; height: number; contentWidth: number; contentHeight: number;
}
export function teedInput(data: Uint8ClampedArray): Float32Array {
  const n = data.length / 4, output = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // TEED training uses byte-scale BGR minus BIPED means, not ImageNet /255.
    output[i] = data[i * 4 + 2] - 103.939;
    output[n + i] = data[i * 4 + 1] - 116.779;
    output[n * 2 + i] = data[i * 4] - 123.68;
  }
  return output;
}
function confidence(map: EdgeMap, x: number, y: number, width: number, height: number) {
  const xx = Math.max(0, Math.min(map.contentWidth - 1, (x + .5) / width * map.contentWidth - .5));
  const yy = Math.max(0, Math.min(map.contentHeight - 1, (y + .5) / height * map.contentHeight - .5));
  const x0 = Math.floor(xx), y0 = Math.floor(yy), x1 = Math.min(map.contentWidth - 1, x0 + 1), y1 = Math.min(map.contentHeight - 1, y0 + 1);
  const fx = xx - x0, fy = yy - y0;
  return (map.data[y0 * map.width + x0] * (1 - fx) + map.data[y0 * map.width + x1] * fx) * (1 - fy)
    + (map.data[y1 * map.width + x0] * (1 - fx) + map.data[y1 * map.width + x1] * fx) * fy;
}

/** Neural confidence only boosts source-supported thin ridges. It cannot draw
 * colors, create a line in a flat area, or grow a silhouette into transparency. */
export function applyAiGuidance(image: PixelSource, features: FeatureMap, map: EdgeMap, amount: number) {
  if (amount <= 0) return;
  const { width, height, data } = image, luminance = features.luminance;
  const strength = Math.min(1, amount / 100), directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x; if (!data[p * 4 + 3]) continue;
    const neural = Math.max(0, Math.min(1, (confidence(map, x, y, width, height) - .1) / .6));
    if (neural <= 0 || features.importance[p] >= strength * neural) continue;
    let ridge = 0;
    for (const [dx, dy] of directions) for (const radius of [1, 2, 3]) {
      const ax = x - dx * radius, ay = y - dy * radius, bx = x + dx * radius, by = y + dy * radius;
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= width || bx >= width || ay >= height || by >= height) continue;
      const a = ay * width + ax, b = by * width + bx;
      if (!data[a * 4 + 3] || !data[b * 4 + 3]) continue;
      const da = luminance[a] - luminance[p], db = luminance[b] - luminance[p];
      if (da * db <= 0) continue;
      const contrast = Math.max(0, Math.min(Math.abs(da), Math.abs(db)) - .005) / .1;
      ridge = Math.max(ridge, Math.min(1, contrast) * Math.max(0, 1 - Math.abs(luminance[a] - luminance[b]) / .25));
    }
    features.importance[p] = Math.max(features.importance[p], strength * neural * ridge);
  }
}

export function edgePreview(map: EdgeMap): PixelSource {
  const { contentWidth: width, contentHeight: height } = map, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, value = 255 * (1 - map.data[y * map.width + x]);
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return { data, width, height };
}
