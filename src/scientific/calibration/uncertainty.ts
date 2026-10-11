import type { MeasurementUncertainty } from '../types';
export function measurementUncertainty(calibrationUncertaintyMm:number,segmentationUncertaintyMm:number):MeasurementUncertainty{const combined=Math.sqrt(calibrationUncertaintyMm**2+segmentationUncertaintyMm**2);return {calibrationUncertaintyMm,segmentationUncertaintyMm,combinedUncertaintyMm:combined};}
