import { deltaE00Bounded } from '../color/ciede2000';
import type { Lab, PhaseMask, SegmentationConfig } from '../types';

/** True when the pixel colour is within the configured CIEDE2000 distance of the reference colour. */
export function classifyLab(lab: Lab, cfg: SegmentationConfig): boolean {
  return deltaE00Bounded(lab, cfg.referenceLab, cfg.deltaEThreshold) <= cfg.deltaEThreshold;
}

export interface ClassifiedField {
  mask: PhaseMask;
  /**
   * CIEDE2000 distance to the reference colour for every pixel inside the ROI.
   * Values ≤ 1.5 × threshold are exact; larger values are a certain lower bound (see deltaE00Bounded).
   * Pixels outside the ROI hold Infinity.
   */
  deltaE: Float32Array;
}

/** Perceptual distance + thresholding for the whole image in one pass. */
export function classifyField(labField: Float32Array, width: number, height: number, cfg: SegmentationConfig): ClassifiedField {
  const mask = new Uint8Array(width * height);
  const deltaE = new Float32Array(width * height).fill(Infinity);
  const roi = cfg.roi;
  const x0 = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const y0 = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const x1 = roi ? Math.min(width, Math.ceil(roi.x + roi.width)) : width;
  const y1 = roi ? Math.min(height, Math.ceil(roi.y + roi.height)) : height;
  const T = cfg.deltaEThreshold;
  const cutoff = T * 1.5; // exact distance is only needed up to the "ambiguous" band
  const ref = cfg.referenceLab;
  const px: Lab = [0, 0, 0];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x, p = i * 3;
      px[0] = labField[p]; px[1] = labField[p + 1]; px[2] = labField[p + 2];
      const d = deltaE00Bounded(px, ref, cutoff);
      deltaE[i] = d;
      if (d <= T) mask[i] = 1;
    }
  }
  return { mask: { width, height, data: mask }, deltaE };
}

/** Mask only (kept for callers that do not need the distance field). */
export function maskFromLab(labField: Float32Array, width: number, height: number, cfg: SegmentationConfig): PhaseMask {
  return classifyField(labField, width, height, cfg).mask;
}
