import type { PhaseMask } from '../types';

export function area(mask: PhaseMask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) n += mask.data[i] ? 1 : 0;
  return n;
}

/** Share of mask pixels that have at least two mask neighbours (8-neighbourhood): near 1 for solid regions, low for dust. */
export function boundaryContinuity(mask: PhaseMask): number {
  const { width: w, height: h, data } = mask;
  let total = 0, continuous = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!data[y * w + x]) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && data[yy * w + xx]) nb++;
    }
    total++;
    if (nb >= 2) continuous++;
  }
  return total ? continuous / total : 0;
}

/** area / bounding-box area of the mask (1 = fills its box, → 0 for thin or scattered shapes). */
export function bboxFill(mask: PhaseMask): number {
  const { width: w, height: h, data } = mask;
  let minX = w, maxX = -1, minY = h, maxY = -1, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x]) {
    n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!n) return 0;
  return n / ((maxX - minX + 1) * (maxY - minY + 1));
}

/**
 * Smoothness of the top edge: for every pair of neighbouring columns that both contain the phase, the fraction whose
 * top edges differ by ≤ `maxStep` pixels. 1 = smooth outline, → 0 = ragged edge. Returns 0 when fewer than two columns qualify.
 */
export function topEdgeSmoothness(mask: PhaseMask, maxStep = 3): number {
  const { width: w, height: h, data } = mask;
  const top = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (data[y * w + x]) { top[x] = y; break; }
  let pairs = 0, smooth = 0;
  for (let x = 0; x < w - 1; x++) {
    if (top[x] < 0 || top[x + 1] < 0) continue;
    pairs++;
    if (Math.abs(top[x] - top[x + 1]) <= maxStep) smooth++;
  }
  return pairs ? smooth / pairs : 0;
}
