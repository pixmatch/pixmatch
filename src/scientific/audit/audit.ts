import type { ExperimentResult } from '../types';

/** True when the audit record carries everything needed to reproduce the run. */
export function validateAudit(result: ExperimentResult): boolean {
  const a = result.audit;
  return a.frameCount >= 0 && !!a.algorithmVersion && a.calibration.mmPerPixel > 0
    && !!a.processingStartedAt && !!a.processingCompletedAt
    && a.segmentationConfig.referenceLab.every(Number.isFinite) && a.segmentationConfig.deltaEThreshold > 0;
}
