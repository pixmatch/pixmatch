import type { PhaseMask } from '../types';

/** The actual outline of a phase mask. */
export interface PhaseBoundary {
  width: number;
  height: number;
  /** 1 = mask pixel that touches the background (4-neighbourhood) or the image border. */
  edge: Uint8Array;
  edgePixelCount: number;
  /** Per column: row of the topmost / bottommost mask pixel, −1 where the column has none. */
  topProfile: Int32Array;
  bottomProfile: Int32Array;
}

/** Boundary extraction: keeps only mask pixels that have a background (or out-of-image) 4-neighbour, and records each column's top and bottom edge. */
export function extractBoundary(mask: PhaseMask): PhaseBoundary {
  const { width: w, height: h, data } = mask;
  const edge = new Uint8Array(data.length);
  const topProfile = new Int32Array(w).fill(-1), bottomProfile = new Int32Array(w).fill(-1);
  let count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!data[i]) continue;
    if (topProfile[x] < 0) topProfile[x] = y;
    bottomProfile[x] = y;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !data[i - 1] || !data[i + 1] || !data[i - w] || !data[i + w]) { edge[i] = 1; count++; }
  }
  return { width: w, height: h, edge, edgePixelCount: count, topProfile, bottomProfile };
}

/**
 * Share of boundary pixels that touch at least two other boundary pixels (8-neighbourhood).
 * A clean closed outline scores ≈ 1; a dusty or fragmented one scores low.
 */
export function boundaryConnectivity(b: PhaseBoundary): number {
  const { width: w, height: h, edge } = b;
  if (!b.edgePixelCount) return 0;
  let connected = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!edge[y * w + x]) continue;
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && edge[yy * w + xx]) nb++;
    }
    if (nb >= 2) connected++;
  }
  return connected / b.edgePixelCount;
}

/** Fraction of neighbouring columns (both containing the phase) whose top edges differ by ≤ maxStep pixels. */
export function profileSmoothness(profile: Int32Array, maxStep = 3): number {
  let pairs = 0, smooth = 0;
  for (let x = 0; x < profile.length - 1; x++) {
    if (profile[x] < 0 || profile[x + 1] < 0) continue;
    pairs++;
    if (Math.abs(profile[x] - profile[x + 1]) <= maxStep) smooth++;
  }
  return pairs ? smooth / pairs : 0;
}
