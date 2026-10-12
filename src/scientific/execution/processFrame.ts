import { segmentFrame } from '../segmentation/segmentFrame';
import { boundsFromBoundary, extractVerticalBounds } from '../geometry/bounds';
import { boundaryConnectivity, extractBoundary } from '../geometry/boundary';
import { assertValidCalibration, computePhysicalHeight } from '../calibration/calibration';
import { measurementUncertainty } from '../calibration/uncertainty';
import { phaseStatistics, scoreConfidence } from '../quality/confidence';
import type { BatchRecipe, FrameProcessingResult, ImageFrame, MeasurementDefinition, MeasurementResult, PhaseMask } from '../types';

function empty(frame: ImageFrame | undefined, def: MeasurementDefinition, recipe: BatchRecipe, status: MeasurementResult['status'], notes?: string[]): MeasurementResult {
  return {
    frameIndex: frame?.frameIndex ?? -1, frameName: frame?.name, measurementId: def.id,
    minY: null, maxY: null, centroidY: null, pixelHeight: null, physicalHeightMm: null,
    confidence: 0, status, calibrationScaleMmPerPixel: recipe.calibration.mmPerPixel,
    algorithmVersion: recipe.algorithmVersion, measurementConvention: def.measurementConvention, notes,
  };
}

/** True when the frame buffer is internally consistent (positive size, RGBA length matches). */
export function isValidFrame(frame: ImageFrame | undefined): frame is ImageFrame {
  return !!frame && frame.width > 0 && frame.height > 0 && !!frame.data && frame.data.length === frame.width * frame.height * 4;
}

/**
 * One frame, every measurement in the recipe:
 * Lab → ΔE00 phase classification → mask → vertical bounds → pixel height → mm → confidence/status.
 * Never throws for bad data: problems become a status plus notes, so a batch always completes.
 */
export function processFrame(frame: ImageFrame, recipe: BatchRecipe): FrameProcessingResult {
  const results: MeasurementResult[] = [];
  const masks: Record<string, PhaseMask> = {};
  if (!isValidFrame(frame)) {
    return { results: recipe.measurements.map(m => empty(frame, m, recipe, 'INVALID_FRAME', ['frame_buffer_inconsistent'])) };
  }
  const minimum = recipe.confidence?.minimumAcceptable ?? 0.6;
  for (const def of recipe.measurements) {
    try {
      const seg = segmentFrame(frame, def.segmentation);
      if (recipe.preserveMasks) masks[def.id] = seg.mask;
      // actual boundary extraction → vertical bounds (percentile trimming, when on, works on the mask's row counts)
      const boundary = extractBoundary(seg.mask);
      const trim = def.segmentation.percentileBoundary?.enabled;
      const bounds = trim
        ? extractVerticalBounds(seg.mask, def.measurementConvention, def.segmentation.percentileBoundary)
        : (() => { const b = boundsFromBoundary(boundary, def.measurementConvention); const m = b && extractVerticalBounds(seg.mask, def.measurementConvention); return b && m ? { ...m, ...b } : null; })();
      if (!bounds) { results.push(empty(frame, def, recipe, 'MISSING_PHASE', ['no_pixels_within_deltaE_threshold'])); continue; }

      const notes: string[] = [];
      let pixelHeight = bounds.pixelHeight;
      let baselineY: number | null = null;
      if (def.baselineY != null && Number.isFinite(def.baselineY)) {
        baselineY = def.baselineY;
        pixelHeight = def.baselineY - bounds.minY + (def.measurementConvention === 'INCLUSIVE_PIXEL' ? 1 : 0);
        if (pixelHeight <= 0) { notes.push('baseline_not_below_top'); pixelHeight = 0; }
      }
      if (seg.illuminationGain !== 1) notes.push(`illumination_gain=${seg.illuminationGain.toFixed(3)}`);

      const threshold = def.segmentation.deltaEThreshold;
      const stats = phaseStatistics(seg.mask, seg.labField, seg.deltaE, threshold);
      const connectivity = boundaryConnectivity(boundary);
      const { score, parts } = scoreConfidence(seg.mask, stats, recipe.confidence ?? { minimumAcceptable: minimum }, threshold, boundary);

      const physical = def.quantity === 'HEIGHT' ? computePhysicalHeight({ pixelHeight }, recipe.calibration) : null;
      const segUnc = recipe.calibration.mmPerPixel * 0.5;
      const calUnc = (recipe.calibration.uncertaintyMmPerPixel ?? 0) * pixelHeight;
      const lowConfidence = score < minimum || notes.includes('baseline_not_below_top');
      results.push({
        frameIndex: frame.frameIndex, frameName: frame.name, measurementId: def.id,
        minY: bounds.minY, maxY: bounds.maxY, centroidY: bounds.centroidY,
        pixelHeight, physicalHeightMm: physical,
        confidence: score, confidenceParts: parts,
        status: lowConfidence ? 'LOW_CONFIDENCE' : 'VALID',
        calibrationScaleMmPerPixel: recipe.calibration.mmPerPixel,
        algorithmVersion: recipe.algorithmVersion, measurementConvention: def.measurementConvention,
        uncertainty: measurementUncertainty(calUnc, segUnc),
        componentCount: stats.componentCount, areaPixels: stats.areaPixels,
        boundaryContinuity: connectivity, meanDeltaE: stats.meanDeltaE ?? undefined,
        baselineY, notes: notes.length ? notes : undefined,
      });
    } catch (error) {
      results.push(empty(frame, def, recipe, 'SEGMENTATION_FAILED', [String((error as Error)?.message ?? error)]));
    }
  }
  return { results, masks };
}

export { assertValidCalibration };
