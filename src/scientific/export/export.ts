import type { ExperimentResult } from '../types';

const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;

export const CSV_HEADER = [
  'frame', 'frameName', 'measurementId', 'status', 'confidence', 'minY', 'maxY', 'centroidY', 'pixelHeight', 'heightMm',
  'mmPerPixel', 'calibrationUncertaintyMm', 'segmentationUncertaintyMm', 'combinedUncertaintyMm',
  'areaPixels', 'componentCount', 'meanDeltaE', 'baselineY',
  'conf_area', 'conf_continuity', 'conf_compactness', 'conf_colorMargin', 'conf_components', 'conf_unknown', 'conf_contrast', 'conf_smoothness',
  'algorithmVersion', 'measurementConvention', 'notes',
];

export function exportCSV(result: ExperimentResult): string {
  const rows = result.results.map(r => [
    r.frameIndex, r.frameName, r.measurementId, r.status, r.confidence, r.minY, r.maxY, r.centroidY, r.pixelHeight, r.physicalHeightMm,
    r.calibrationScaleMmPerPixel, r.uncertainty?.calibrationUncertaintyMm, r.uncertainty?.segmentationUncertaintyMm, r.uncertainty?.combinedUncertaintyMm,
    r.areaPixels, r.componentCount, r.meanDeltaE, r.baselineY,
    r.confidenceParts?.area, r.confidenceParts?.continuity, r.confidenceParts?.compactness, r.confidenceParts?.colorMargin,
    r.confidenceParts?.components, r.confidenceParts?.unknown, r.confidenceParts?.contrast, r.confidenceParts?.smoothness,
    r.algorithmVersion, r.measurementConvention, r.notes?.join('; '),
  ]);
  return [CSV_HEADER, ...rows].map(r => r.map(esc).join(',')).join('\n');
}
export function exportJSON(result: ExperimentResult): string { return JSON.stringify(result, null, 2); }
/** The provenance record alone (calibration, segmentation settings, versions, timestamps, status counts, warnings). */
export function exportAuditJSON(result: ExperimentResult): string { return JSON.stringify(result.audit, null, 2); }
