import { imageToLab } from '../color/rgbToLab';
import { classifyField } from './phaseClassifier';
import { opening, closing, fillHoles } from './morphology';
import { filterComponents } from './connectedComponents';
import type { ImageFrame, PhaseMask, SegmentationConfig } from '../types';

export interface SegmentedFrame {
  mask: PhaseMask;
  /** Interleaved L*a*b* of the (illumination-corrected) frame. */
  labField: Float32Array;
  /** CIEDE2000 distance field, see ClassifiedField. */
  deltaE: Float32Array;
  /** The gain applied to L*, a*, b* (1 when illumination matching is off). */
  illuminationGain: number;
}

/** Median L* (0–100) of the pixels inside the ROI, from a 0.1-unit histogram. */
export function medianL(labField: Float32Array, width: number, height: number, roi?: SegmentationConfig['roi']): number {
  const bins = new Uint32Array(1001);
  const x0 = roi ? Math.max(0, Math.floor(roi.x)) : 0, y0 = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const x1 = roi ? Math.min(width, Math.ceil(roi.x + roi.width)) : width, y1 = roi ? Math.min(height, Math.ceil(roi.y + roi.height)) : height;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const L = labField[(y * width + x) * 3];
    bins[Math.max(0, Math.min(1000, Math.round(L * 10)))]++;
    n++;
  }
  if (!n) return 0;
  let acc = 0;
  for (let i = 0; i <= 1000; i++) { acc += bins[i]; if (acc * 2 >= n) return i / 10; }
  return 100;
}

/** Lab → perceptual distance → mask → cleanup. Every frame is segmented independently of every other frame. */
export function segmentFrame(frame: ImageFrame, cfg: SegmentationConfig): SegmentedFrame {
  const labField = imageToLab(frame);
  let illuminationGain = 1;
  if (cfg.illumination?.enabled && cfg.illumination.targetMedianL != null) {
    // A uniform exposure change multiplies XYZ, which scales L*, a* and b* by roughly the same factor, so the
    // correction is a gain on all three channels (clamped to 0.5–2 so a failed estimate cannot distort the frame).
    const median = medianL(labField, frame.width, frame.height, cfg.roi);
    if (median > 1) illuminationGain = Math.max(0.5, Math.min(2, cfg.illumination.targetMedianL / median));
    if (illuminationGain !== 1) for (let p = 0; p < labField.length; p++) labField[p] *= illuminationGain;
  }
  const classified = classifyField(labField, frame.width, frame.height, cfg);
  let mask = classified.mask;
  const m = cfg.morphology;
  if (m?.enabled) {
    if (m.openingRadius > 0) mask = opening(mask, m.openingRadius, cfg.roi);
    if (m.closingRadius > 0) mask = closing(mask, m.closingRadius, cfg.roi);
    if (m.fillHoles) mask = fillHoles(mask);
  }
  const cc = cfg.connectedComponents;
  if (cc?.enabled) mask = filterComponents(mask, cc.minimumAreaPixels, cc.maximumAreaPixels, cc.keepLargestOnly);
  return { mask, labField, deltaE: classified.deltaE, illuminationGain };
}
