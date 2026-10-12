import type { CalibrationConfig, SpatialBounds } from '../types';

/** Millimetres per one unit of each length unit PixMatch can calibrate in. 'px' has no physical meaning. */
export const UNIT_TO_MM: Record<string, number | undefined> = { mm: 1, 'µm': 0.001, um: 0.001, cm: 10, m: 1000, in: 25.4 };

/** mm/px from a "pixels per <unit>" scale. Returns null when uncalibrated or the unit is px. */
export function mmPerPixelFromScale(pxPerUnit: number, unit: string): number | null {
  const f = UNIT_TO_MM[unit];
  if (!f || !Number.isFinite(pxPerUnit) || pxPerUnit <= 0) return null;
  return f / pxPerUnit;
}

export function calculateCalibrationScale(knownDistanceMm: number, measuredDistancePx: number): number {
  if (!Number.isFinite(knownDistanceMm) || knownDistanceMm <= 0 || !Number.isFinite(measuredDistancePx) || measuredDistancePx <= 0) {
    throw new Error('INVALID_CALIBRATION');
  }
  return knownDistanceMm / measuredDistancePx;
}
export function assertValidCalibration(cal: CalibrationConfig): void {
  if (!Number.isFinite(cal.mmPerPixel) || cal.mmPerPixel <= 0) throw new Error('INVALID_CALIBRATION');
}
export function computePhysicalHeight(bounds: Pick<SpatialBounds, 'pixelHeight'>, cal: CalibrationConfig): number {
  assertValidCalibration(cal);
  return bounds.pixelHeight * cal.mmPerPixel;
}
