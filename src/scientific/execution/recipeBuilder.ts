import type { BatchRecipe, Lab, MeasurementConvention, SegmentationConfig } from '../types';

/** Written into every result and audit record so a number can be traced to the code that produced it. */
export const ENGINE_VERSION = 'pixmatch-engine-1.4.0';

export interface HeightRecipeOptions {
  referenceLab: Lab;
  /** CIEDE2000 tolerance around referenceLab. */
  deltaE: number;
  mmPerPixel: number;
  uncertaintyMmPerPixel?: number;
  convention?: MeasurementConvention;
  /** Row to measure down to instead of the bottom of the phase. */
  baselineY?: number | null;
  openingRadius?: number;
  closingRadius?: number;
  fillHoles?: boolean;
  minimumAreaPixels?: number;
  keepLargestOnly?: boolean;
  /** Ignore this share (%) of mask pixels at each vertical end; 0 = off. */
  trimPercent?: number;
  /** Median L* of the reference frame; enables exposure matching when set. */
  targetMedianL?: number | null;
  allowInterpolation?: boolean;
  minimumConfidence?: number;
  roi?: SegmentationConfig['roi'];
}

/** Turns the handful of user-facing settings into the full engine recipe (one HEIGHT measurement of the target phase). */
export function buildHeightRecipe(o: HeightRecipeOptions): BatchRecipe {
  const morph = (o.openingRadius ?? 0) > 0 || (o.closingRadius ?? 0) > 0 || !!o.fillHoles;
  const trim = o.trimPercent ?? 0;
  return {
    algorithmVersion: ENGINE_VERSION,
    calibration: { mmPerPixel: o.mmPerPixel, uncertaintyMmPerPixel: o.uncertaintyMmPerPixel },
    allowInterpolation: !!o.allowInterpolation,
    confidence: { minimumAcceptable: o.minimumConfidence ?? 0.6 },
    measurements: [{
      id: 'height', name: 'Height', phase: 'TARGET_PHASE', quantity: 'HEIGHT',
      measurementConvention: o.convention ?? 'INCLUSIVE_PIXEL',
      baselineY: o.baselineY ?? undefined,
      segmentation: {
        colorSpace: 'CIELAB', targetPhase: 'TARGET_PHASE', referenceLab: o.referenceLab, deltaEThreshold: o.deltaE, roi: o.roi,
        morphology: morph ? { enabled: true, openingRadius: o.openingRadius ?? 0, closingRadius: o.closingRadius ?? 0, fillHoles: !!o.fillHoles } : undefined,
        connectedComponents: { enabled: true, minimumAreaPixels: o.minimumAreaPixels ?? 20, keepLargestOnly: o.keepLargestOnly ?? true },
        illumination: o.targetMedianL != null ? { enabled: true, targetMedianL: o.targetMedianL } : undefined,
        percentileBoundary: trim > 0 ? { enabled: true, low: trim, high: 100 - trim } : undefined,
      },
    }],
  };
}
