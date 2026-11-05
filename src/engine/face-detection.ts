import classifier from '../../public/models/anime-face-lbp.json';

export type FaceBox = [number, number, number, number];
// Independent MB-LBP evaluator for nagadomi's MIT cascade. This is only the
// bounding-box proposal step; HRNet validates and locates the actual features.
export function detectAnimeFaces(gray: Uint8Array, width: number, height: number): FaceBox[] {
  if (gray.length !== width * height || width < 24 || height < 24) return [];
  const hist = new Uint32Array(256), lut = new Uint8Array(256);
  for (const v of gray) hist[v]++;
  let first = 0; while (!hist[first]) first++;
  if (hist[first] === gray.length) return [];
  let cumulative = 0;
  for (let i = 0; i < 256; i++) { cumulative += hist[i]; lut[i] = Math.max(0, Math.round((cumulative - hist[first]) * 255 / (gray.length - hist[first]))); }
  const equalized = Uint8Array.from(gray, v => lut[v]);
  const proposals: FaceBox[] = [];
  // Using a resized pyramid keeps the integer 24x24 classifier geometry intact.
  for (let scale = 1; 24 * scale <= Math.min(width, height); scale *= 1.1) {
    const w = Math.round(width / scale), h = Math.round(height / scale), stride = w + 1;
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      const sy = Math.min(height - 1, Math.max(0, (y + .5) * height / h - .5)), y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.min(width - 1, Math.max(0, (x + .5) * width / w - .5)), x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
        row += Math.round((equalized[y0 * width + x0] * (1 - fx) + equalized[y0 * width + x1] * fx) * (1 - fy) + (equalized[y1 * width + x0] * (1 - fx) + equalized[y1 * width + x1] * fx) * fy);
        integral[(y + 1) * stride + x + 1] = row + integral[y * stride + x + 1];
      }
    }
    const rect = (x: number, y: number, rw: number, rh: number) => integral[(y + rh) * stride + x + rw] - integral[y * stride + x + rw] - integral[(y + rh) * stride + x] + integral[y * stride + x];
    for (let y = 0; y <= h - 24; y += 2) for (let x = 0; x <= w - 24; x += 2) {
      let accepted = true;
      for (const stage of classifier.stages) {
        const [threshold, weak] = stage as [number, [number, number[], number[]][]];
        let sum = 0;
        for (const [feature, subsets, leaves] of weak) {
          const [rx, ry, rw, rh] = classifier.features[feature], px = x + rx, py = y + ry;
          const middle = rect(px + rw, py + rh, rw, rh);
          let code = 0;
          if (rect(px, py, rw, rh) >= middle) code |= 128;
          if (rect(px + rw, py, rw, rh) >= middle) code |= 64;
          if (rect(px + 2 * rw, py, rw, rh) >= middle) code |= 32;
          if (rect(px + 2 * rw, py + rh, rw, rh) >= middle) code |= 16;
          if (rect(px + 2 * rw, py + 2 * rh, rw, rh) >= middle) code |= 8;
          if (rect(px + rw, py + 2 * rh, rw, rh) >= middle) code |= 4;
          if (rect(px, py + 2 * rh, rw, rh) >= middle) code |= 2;
          if (rect(px, py + rh, rw, rh) >= middle) code |= 1;
          sum += leaves[(subsets[code >> 5] & (1 << (code & 31))) ? 0 : 1];
        }
        if (sum < threshold) { accepted = false; break; }
      }
      if (accepted && proposals.length < 2048) proposals.push([x * scale, y * scale, 24 * scale, 24 * scale]);
    }
  }
  // Transitive grouping across neighboring windows and adjacent pyramid levels.
  const parent = Int32Array.from(proposals, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < proposals.length; i++) for (let j = 0; j < i; j++) {
    const a = proposals[i], b = proposals[j], delta = .2 * Math.min(a[2], b[2]);
    if (Math.abs(a[0] - b[0]) <= delta && Math.abs(a[1] - b[1]) <= delta && Math.abs(a[0] + a[2] - b[0] - b[2]) <= delta && Math.abs(a[1] + a[3] - b[1] - b[3]) <= delta) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  proposals.forEach((box, i) => { const key = find(i), sum = groups.get(key) ?? [0, 0, 0, 0, 0]; box.forEach((v, k) => { sum[k] += v; }); sum[4]++; groups.set(key, sum); });
  const ranked = [...groups.values()].filter(g => g[4] >= 3).sort((a, b) => b[4] - a[4]);
  const boxes: FaceBox[] = [];
  for (const g of ranked) {
    const a = g.slice(0, 4).map(v => v / g[4]) as FaceBox;
    if (boxes.some(b => { const overlap = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])); return overlap / Math.min(a[2] * a[3], b[2] * b[3]) > .4; })) continue;
    boxes.push(a); if (boxes.length === 4) break;
  }
  return boxes;
}
