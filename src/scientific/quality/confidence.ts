import type { ConfidenceConfig, ConfidenceParts, Lab, PhaseMask } from '../types';
import { deltaE00 } from '../color/ciede2000';
import { area, bboxFill } from '../geometry/metrics';
import { boundaryConnectivity, extractBoundary, profileSmoothness, type PhaseBoundary } from '../geometry/boundary';
import { labelComponents } from '../segmentation/connectedComponents';

export const DEFAULT_CONFIDENCE_WEIGHTS: ConfidenceParts = {
  area: 0.2, continuity: 0.3, compactness: 0.1, colorMargin: 0.15, components: 0.1, unknown: 0.05, contrast: 0.05, smoothness: 0.05,
};
/** A phase smaller than this many pixels earns less than full area credit. */
export const REFERENCE_AREA_PIXELS = 500;

export interface PhaseStatistics {
  areaPixels: number;
  componentCount: number;
  largestComponentArea: number;
  /** Mean CIEDE2000 of pixels inside the mask (null when empty). */
  meanDeltaE: number | null;
  /** Pixels just outside the threshold (T < ΔE ≤ 1.5 T): neither clearly in nor clearly out. */
  ambiguousPixels: number;
  /** Mean Lab inside / outside the mask (outside = inside ROI/image, excluding the mask). */
  meanLabIn: Lab | null;
  meanLabOut: Lab | null;
}

/** One pass over the frame: everything the quality terms need. */
export function phaseStatistics(mask: PhaseMask, labField: Float32Array, deltaE: Float32Array, threshold: number): PhaseStatistics {
  const n = mask.data.length;
  let inN = 0, outN = 0, dSum = 0, amb = 0;
  const sIn = [0, 0, 0], sOut = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = deltaE[i];
    if (!Number.isFinite(d)) continue; // outside the ROI
    const p = i * 3;
    if (mask.data[i]) {
      inN++; dSum += d;
      sIn[0] += labField[p]; sIn[1] += labField[p + 1]; sIn[2] += labField[p + 2];
    } else {
      outN++;
      sOut[0] += labField[p]; sOut[1] += labField[p + 1]; sOut[2] += labField[p + 2];
      if (d > threshold && d <= threshold * 1.5) amb++;
    }
  }
  const { components } = labelComponents(mask);
  return {
    areaPixels: area(mask),
    componentCount: components.length,
    largestComponentArea: components.reduce((m, c) => Math.max(m, c.area), 0),
    meanDeltaE: inN ? dSum / inN : null,
    ambiguousPixels: amb,
    meanLabIn: inN ? [sIn[0] / inN, sIn[1] / inN, sIn[2] / inN] : null,
    meanLabOut: outN ? [sOut[0] / outN, sOut[1] / outN, sOut[2] / outN] : null,
  };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * Confidence = weighted sum of eight measured terms, each in 0..1:
 *  area         min(1, area / 500 px)
 *  continuity   share of boundary pixels with ≥ 2 boundary neighbours (closed, connected outline)
 *  compactness  area / bounding-box area
 *  colorMargin  1 − meanΔE / threshold            (pixels sit well inside the colour tolerance)
 *  components   largest component area / total area (1 = a single connected region)
 *  unknown      1 − ambiguous / (ambiguous + mask pixels)
 *  contrast     ΔE00(mean inside, mean outside) / (3·threshold), capped at 1
 *  smoothness   fraction of neighbouring columns whose top boundary rows differ by ≤ 3 px
 * Nothing here is a fixed constant: an empty mask scores 0.
 */
export function scoreConfidence(mask: PhaseMask, stats: PhaseStatistics, cfg: ConfidenceConfig, threshold: number, boundary: PhaseBoundary = extractBoundary(mask)): { score: number; parts: ConfidenceParts } {
  const zero: ConfidenceParts = { area: 0, continuity: 0, compactness: 0, colorMargin: 0, components: 0, unknown: 0, contrast: 0, smoothness: 0 };
  if (!stats.areaPixels) return { score: 0, parts: zero };
  const parts: ConfidenceParts = {
    area: clamp01(stats.areaPixels / REFERENCE_AREA_PIXELS),
    continuity: clamp01(boundaryConnectivity(boundary)),
    compactness: clamp01(bboxFill(mask)),
    colorMargin: stats.meanDeltaE == null ? 0 : clamp01(1 - stats.meanDeltaE / threshold),
    components: clamp01(stats.largestComponentArea / stats.areaPixels),
    unknown: clamp01(1 - stats.ambiguousPixels / (stats.ambiguousPixels + stats.areaPixels)),
    contrast: stats.meanLabIn && stats.meanLabOut ? clamp01(deltaE00(stats.meanLabIn, stats.meanLabOut) / (3 * threshold)) : 0,
    smoothness: clamp01(profileSmoothness(boundary.topProfile)),
  };
  const w = { ...DEFAULT_CONFIDENCE_WEIGHTS, ...cfg.weights };
  const wsum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let score = 0;
  (Object.keys(parts) as (keyof ConfidenceParts)[]).forEach(k => { score += w[k] * parts[k]; });
  return { score: clamp01(score / wsum), parts };
}
