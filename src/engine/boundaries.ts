import type { RGB } from './types';
import type { StructureResult } from './structure';

const OFFSETS = [[-1, -1, .7071], [0, -1, 1], [1, -1, .7071], [-1, 0, 1], [1, 0, 1], [-1, 1, .7071], [0, 1, 1], [1, 1, .7071]];

// Number of local components. Foreground is 8-connected, background 4-connected.
// A move is rejected if it breaks a thin bridge, fills a hole, or joins regions.
function components(mask: number, diagonal: boolean) {
  let count = 0;
  while (mask) {
    const first = 31 - Math.clz32(mask & -mask);
    let front = 1 << first; mask &= ~front; count++;
    while (front) {
      const p = 31 - Math.clz32(front & -front); front &= ~(1 << p);
      const x = p % 3, y = Math.floor(p / 3);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!diagonal && dx && dy) || x + dx < 0 || x + dx > 2 || y + dy < 0 || y + dy > 2) continue;
        const bit = 1 << ((y + dy) * 3 + x + dx);
        if (mask & bit) { mask &= ~bit; front |= bit; }
      }
    }
  }
  return count;
}

function simpleMove(labels: Int16Array, width: number, p: number, from: number, to: number) {
  let oldMask = 0, newMask = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const label = labels[p + dy * width + dx], bit = 1 << ((dy + 1) * 3 + dx + 1);
    if (label === from) oldMask |= bit;
    if (label === to) newMask |= bit;
  }
  const ring = 0b111101111;
  return components(oldMask, true) <= 1 && components(newMask, true) <= 1
    && components(ring & ~oldMask, false) <= 1 && components(ring & ~newMask, false) <= 1;
}

/** Coordinate descent of source evidence + an isotropic boundary-length cost.
 * Four source-supported alternatives per cell keep memory bounded at 512 px /
 * 256 colors. No candidate invents a color or moves into transparent space.
 */
export function regularizeBoundaries(result: StructureResult, width: number, height: number, palette: RGB[], amount: number) {
  const { labels, candidates, scores } = result;
  if (!candidates || !scores || amount <= 0) return;
  const lambda = Math.min(1, amount / 100) * .16;
  for (let pass = 0; pass < 3; pass++) {
    let changed = 0;
    for (let parity = 0; parity < 2; parity++) for (let row = 1; row < height - 1; row++) {
      const y = pass % 2 ? height - 1 - row : row;
      for (let column = 1; column < width - 1; column++) {
        const x = pass % 2 ? width - 1 - column : column;
        if ((x + y) % 2 !== parity) continue;
        const p = y * width + x, current = labels[p];
        if (current < 0 || result.coverage[p] < .99 || result.protected[p] >= .5) continue;
        let transparent = false;
        for (const [dx, dy] of OFFSETS) if (labels[p + dy * width + dx] < 0) transparent = true;
        if (transparent) continue;
        const energy = (label: number, score: number) => {
          let boundary = 0;
          for (const [dx, dy, weight] of OFFSETS) if (labels[p + dy * width + dx] !== label) boundary += weight;
          return scores[p * 4] - score + lambda * boundary;
        };
        let currentScore = -Infinity;
        for (let k = 0; k < 4; k++) if (candidates[p * 4 + k] === current) currentScore = scores[p * 4 + k];
        let best = current, bestEnergy = energy(current, currentScore);
        for (let k = 0; k < 4; k++) {
          const candidate = candidates[p * 4 + k];
          if (candidate < 0 || candidate === current) continue;
          const value = energy(candidate, scores[p * 4 + k]);
          if (value < bestEnergy - 1e-5) { best = candidate; bestEnergy = value; }
        }
        if (best !== current && simpleMove(labels, width, p, current, best)) {
          labels[p] = best; result.data.set([...palette[best], 255], p * 4); changed++;
        }
      }
    }
    if (!changed) break;
  }
}
