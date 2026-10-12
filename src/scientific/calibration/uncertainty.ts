import type { MeasurementUncertainty } from '../types';

/**
 * Combine independent 1-sigma contributions in quadrature.
 *  calibration  = σ(mm/px) × pixelHeight
 *  segmentation = ½ pixel × mm/px  (the edge position is only known to the nearest pixel)
 */
export function measurementUncertainty(calibrationUncertaintyMm: number, segmentationUncertaintyMm: number): MeasurementUncertainty {
  return {
    calibrationUncertaintyMm,
    segmentationUncertaintyMm,
    combinedUncertaintyMm: Math.sqrt(calibrationUncertaintyMm ** 2 + segmentationUncertaintyMm ** 2),
  };
}
