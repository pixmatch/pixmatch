export type RGB = [number, number, number];
export type XYZ = [number, number, number];
export type Lab = [number, number, number];
export type PhaseType = 'TARGET_PHASE' | 'SECONDARY_PHASE' | 'BACKGROUND' | 'UNKNOWN';
export type MeasurementStatus = 'VALID' | 'LOW_CONFIDENCE' | 'MISSING_PHASE' | 'INVALID_FRAME' | 'SEGMENTATION_FAILED' | 'INTERPOLATED';
export type MeasurementConvention = 'PIXEL_CENTER' | 'INCLUSIVE_PIXEL';

export interface ImageFrame { frameIndex: number; width: number; height: number; data: Uint8ClampedArray; }
export interface PhaseMask { width: number; height: number; data: Uint8Array; }
export interface SpatialBounds { minY: number; maxY: number; centroidY: number; pixelHeight: number; }
export interface CalibrationConfig { mmPerPixel: number; referenceDistanceMm?: number; referenceDistancePx?: number; uncertaintyMmPerPixel?: number; }
export interface SegmentationConfig {
  colorSpace: 'CIELAB'; targetPhase: PhaseType; referenceLab: Lab;
  deltaEThreshold: number; rgbWeight?: number; labWeight?: number;
  roi?: { x: number; y: number; width: number; height: number };
  morphology?: { enabled: boolean; openingRadius: number; closingRadius: number; fillHoles: boolean };
  connectedComponents?: { enabled: boolean; minimumAreaPixels: number; maximumAreaPixels?: number };
  illumination?: { enabled: boolean; targetMedianL?: number };
  percentileBoundary?: { enabled: boolean; low: number; high: number };
}
export interface ConfidenceConfig { minimumAcceptable: number; weights?: { area: number; continuity: number; compactness: number; colorMargin: number; components: number; unknown: number; contrast: number; smoothness: number }; }
export interface MeasurementDefinition {
  id: string; name: string; phase: PhaseType; quantity: 'HEIGHT' | 'SPAN' | 'DISPLACEMENT' | 'ANGLE' | 'AREA' | 'PERIMETER';
  measurementConvention: MeasurementConvention; baselineY?: number; segmentation: SegmentationConfig;
}
export interface BatchRecipe {
  algorithmVersion: string; calibration: CalibrationConfig; measurements: MeasurementDefinition[];
  confidence?: ConfidenceConfig; allowInterpolation: boolean; interpolationMethod?: 'LINEAR' | 'SPLINE'; preserveMasks?: boolean; preserveIntermediateData?: boolean;
}
export interface MeasurementUncertainty { calibrationUncertaintyMm: number; segmentationUncertaintyMm: number; combinedUncertaintyMm: number; }
export interface MeasurementResult {
  frameIndex: number; measurementId: string; minY: number | null; maxY: number | null; centroidY: number | null;
  pixelHeight: number | null; physicalHeightMm: number | null; confidence: number; status: MeasurementStatus;
  calibrationScaleMmPerPixel: number; algorithmVersion: string; measurementConvention: MeasurementConvention;
  uncertainty?: MeasurementUncertainty; componentCount?: number; areaPixels?: number; boundaryContinuity?: number;
}
export interface ProcessingAudit { experimentId: string; algorithmVersion: string; frameCount: number; validFrameCount: number; invalidFrameCount: number; calibration: CalibrationConfig; segmentationConfig: SegmentationConfig; measurementConvention: MeasurementConvention; processingStartedAt: string; processingCompletedAt: string; }
export interface FrameProcessingResult { results: MeasurementResult[]; masks?: Record<string, PhaseMask>; }
export interface ExperimentResult { results: MeasurementResult[]; audit: ProcessingAudit; }
