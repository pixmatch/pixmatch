import { processFrame } from './processFrame';
import { assertValidCalibration } from '../calibration/calibration';
import type { BatchProgress, BatchRecipe, ExperimentResult, ImageFrame, MeasurementResult, ProcessingAudit } from '../types';

/** Rejects a recipe before any frame is touched, so a bad setting can never be mistaken for a bad frame. */
export function validateRecipe(recipe: BatchRecipe): void {
  assertValidCalibration(recipe.calibration);
  if (!recipe.measurements.length) throw new Error('NO_MEASUREMENTS');
  for (const m of recipe.measurements) {
    if (m.quantity !== 'HEIGHT') throw new Error(`UNSUPPORTED_QUANTITY:${m.quantity}`);
    if (!Number.isFinite(m.segmentation.deltaEThreshold) || m.segmentation.deltaEThreshold <= 0) throw new Error('INVALID_DELTA_E_THRESHOLD');
    if (!m.segmentation.referenceLab.every(Number.isFinite)) throw new Error('INVALID_REFERENCE_COLOR');
  }
}

/**
 * Fill MISSING_PHASE frames that sit between two VALID frames of the same measurement (linear in frame index).
 * Only runs when recipe.allowInterpolation is true; filled results are marked INTERPOLATED with a note.
 */
export function interpolate(results: MeasurementResult[], recipe: BatchRecipe): void {
  if (!recipe.allowInterpolation) return;
  const mm = recipe.calibration.mmPerPixel;
  for (const r of results) {
    if (r.status !== 'MISSING_PHASE') continue;
    const valid = results.filter(x => x.measurementId === r.measurementId && x.status === 'VALID' && x.physicalHeightMm != null).sort((a, b) => a.frameIndex - b.frameIndex);
    const lo = [...valid].reverse().find(x => x.frameIndex < r.frameIndex);
    const hi = valid.find(x => x.frameIndex > r.frameIndex);
    if (!lo || !hi) continue;
    const t = (r.frameIndex - lo.frameIndex) / (hi.frameIndex - lo.frameIndex);
    r.physicalHeightMm = lo.physicalHeightMm! + (hi.physicalHeightMm! - lo.physicalHeightMm!) * t;
    r.pixelHeight = r.physicalHeightMm / mm;
    r.status = 'INTERPOLATED';
    r.confidence = Math.min(lo.confidence, hi.confidence);
    r.notes = [...(r.notes ?? []), `interpolated_between_frames_${lo.frameIndex}_and_${hi.frameIndex}`];
  }
}

/** Accumulates frames one at a time (so callers never need every image in memory) and produces the final audited result. */
export class BatchSession {
  private readonly started = new Date().toISOString();
  private readonly results: MeasurementResult[] = [];
  private readonly names: string[] = [];
  private readonly warnings: string[] = [];
  private firstSize: [number, number] | null = null;
  constructor(private readonly experimentId: string, private readonly recipe: BatchRecipe) { validateRecipe(recipe); }

  get processed() { return this.names.length; }

  add(frame: ImageFrame): MeasurementResult[] {
    if (frame?.width > 0 && frame.height > 0) {
      if (!this.firstSize) this.firstSize = [frame.width, frame.height];
      else if (frame.width !== this.firstSize[0] || frame.height !== this.firstSize[1]) {
        this.warnings.push(`frame ${frame.frameIndex}${frame.name ? ` (${frame.name})` : ''} is ${frame.width}×${frame.height}, first frame is ${this.firstSize[0]}×${this.firstSize[1]}: the single mm/px calibration may not apply`);
      }
    }
    const out = processFrame(frame, this.recipe).results;
    this.results.push(...out);
    this.names.push(frame?.name ?? `frame ${frame?.frameIndex}`);
    return out;
  }

  finish(): ExperimentResult {
    interpolate(this.results, this.recipe);
    const statusCounts: Record<string, number> = {};
    for (const r of this.results) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    const first = this.recipe.measurements[0];
    const audit: ProcessingAudit = {
      experimentId: this.experimentId,
      algorithmVersion: this.recipe.algorithmVersion,
      frameCount: this.names.length,
      validFrameCount: this.results.filter(r => r.status === 'VALID').length,
      invalidFrameCount: this.results.filter(r => r.status === 'INVALID_FRAME' || r.status === 'SEGMENTATION_FAILED').length,
      calibration: this.recipe.calibration,
      segmentationConfig: first.segmentation,
      measurementConvention: first.measurementConvention,
      processingStartedAt: this.started,
      processingCompletedAt: new Date().toISOString(),
      measurements: this.recipe.measurements,
      frameNames: this.names,
      statusCounts,
      warnings: this.warnings,
    };
    return { results: this.results, audit };
  }
}

/** Synchronous whole-batch helper (used by tests and the worker fallback). */
export function processBatch(experimentId: string, frames: ImageFrame[], recipe: BatchRecipe, onProgress?: (p: BatchProgress) => void): ExperimentResult {
  const session = new BatchSession(experimentId, recipe);
  frames.forEach((frame, i) => { session.add(frame); onProgress?.({ done: i + 1, total: frames.length, frameIndex: frame.frameIndex }); });
  return session.finish();
}
