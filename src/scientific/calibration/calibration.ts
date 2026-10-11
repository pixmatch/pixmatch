import type { CalibrationConfig, SpatialBounds } from '../types';
export function calculateCalibrationScale(knownDistanceMm:number,measuredDistancePx:number){if(!Number.isFinite(knownDistanceMm)||knownDistanceMm<=0||!Number.isFinite(measuredDistancePx)||measuredDistancePx<=0)throw new Error('INVALID_CALIBRATION');return knownDistanceMm/measuredDistancePx;}
export function computePhysicalHeight(bounds:SpatialBounds,cal:CalibrationConfig){if(!Number.isFinite(cal.mmPerPixel)||cal.mmPerPixel<=0)throw new Error('INVALID_CALIBRATION');return bounds.pixelHeight*cal.mmPerPixel;}
