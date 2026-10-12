import type { MeasurementConvention, PhaseMask, SegmentationConfig, SpatialBounds } from '../types';
import type { PhaseBoundary } from './boundary';

/**
 * Vertical extent of the mask.
 * Default: first and last image row that contain a mask pixel.
 * With `percentile`: the rows below/above which only `low` % / (100−high) % of the mask pixels lie, so isolated
 * specks cannot move the edge. Returns null when the mask is empty.
 */
export function extractVerticalBounds(
  mask: PhaseMask,
  convention: MeasurementConvention,
  percentile?: SegmentationConfig['percentileBoundary'],
): SpatialBounds | null {
  const { width: w, height: h, data } = mask;
  const rows = new Float64Array(h);
  let sumY = 0, n = 0;
  for (let y = 0; y < h; y++) {
    let c = 0;
    const o = y * w;
    for (let x = 0; x < w; x++) if (data[o + x]) c++;
    rows[y] = c; n += c; sumY += c * y;
  }
  if (!n) return null;
  let minY = 0; while (rows[minY] === 0) minY++;
  let maxY = h - 1; while (rows[maxY] === 0) maxY--;
  const p = percentile;
  if (p?.enabled && p.low >= 0 && p.high <= 100 && p.low < p.high) {
    const lowCount = (n * p.low) / 100, highCount = (n * (100 - p.high)) / 100;
    let acc = 0;
    for (let y = 0; y < h; y++) { acc += rows[y]; if (acc > lowCount) { minY = y; break; } }
    acc = 0;
    for (let y = h - 1; y >= 0; y--) { acc += rows[y]; if (acc > highCount) { maxY = y; break; } }
    if (maxY < minY) { const t = minY; minY = maxY; maxY = t; }
  }
  return {
    minY, maxY, centroidY: sumY / n,
    pixelHeight: convention === 'INCLUSIVE_PIXEL' ? maxY - minY + 1 : maxY - minY,
  };
}

/** Same idea along x (left/right extent) — exposed for future SPAN measurements. */
export function extractHorizontalBounds(mask: PhaseMask): { minX: number; maxX: number } | null {
  const { width: w, height: h, data } = mask;
  let minX = w, maxX = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  return maxX < 0 ? null : { minX, maxX };
}

/**
 * Vertical bounds read from the extracted boundary: the highest top edge and the lowest bottom edge over all columns.
 * (For a mask these are the same rows as the mask's own extremes; reading them from the boundary makes the stage
 * explicit and gives the same outline that is drawn in the preview.) Percentile trimming is applied by the mask-based function.
 */
export function boundsFromBoundary(b: PhaseBoundary, convention: MeasurementConvention): { minY: number; maxY: number; pixelHeight: number } | null {
  let minY = Infinity, maxY = -Infinity;
  for (let x = 0; x < b.width; x++) {
    if (b.topProfile[x] < 0) continue;
    if (b.topProfile[x] < minY) minY = b.topProfile[x];
    if (b.bottomProfile[x] > maxY) maxY = b.bottomProfile[x];
  }
  if (!Number.isFinite(minY)) return null;
  return { minY, maxY, pixelHeight: convention === 'INCLUSIVE_PIXEL' ? maxY - minY + 1 : maxY - minY };
}
