/**
 * PixMatch scientific engine — shared types.
 *
 * Pipeline (see ARCHITECTURE.md):
 *   ImageData → RGB→XYZ→Lab → perceptual distance / phase classification → 2-D phase mask
 *   → vertical bounds → pixel height → calibration → physical height (mm) → validated MeasurementResult
 */
export type RGB = [number, number, number];
export type XYZ = [number, number, number];
export type Lab = [number, number, number];
export type PhaseType = 'TARGET_PHASE' | 'SECONDARY_PHASE' | 'BACKGROUND' | 'UNKNOWN';
export type MeasurementStatus =
  | 'VALID'
  | 'LOW_CONFIDENCE'
  | 'MISSING_PHASE'
  | 'INVALID_FRAME'
  | 'SEGMENTATION_FAILED'
  | 'INTERPOLATED';
/** PIXEL_CENTER: height = maxY − minY.  INCLUSIVE_PIXEL: height = maxY − minY + 1 (counts both edge pixels). */
export type MeasurementConvention = 'PIXEL_CENTER' | 'INCLUSIVE_PIXEL';

export interface ImageFrame {
  frameIndex: number;
  width: number;
  height: number;
  /** RGBA, 8 bit, row-major — exactly what CanvasRenderingContext2D.getImageData returns. */
  data: Uint8ClampedArray;
  /** Source file name; carried into every result for traceability. */
  name?: string;
}
/** 1 = pixel belongs to the phase, 0 = it does not. */
export interface PhaseMask { width: number; height: number; data: Uint8Array; }
export interface SpatialBounds { minY: number; maxY: number; centroidY: number; pixelHeight: number; }
export interface CalibrationConfig {
  /** Millimetres per pixel. Must be finite and > 0 — pixel values are never shown as physical without it. */
  mmPerPixel: number;
  referenceDistanceMm?: number;
  referenceDistancePx?: number;
  /** 1-sigma uncertainty of the scale, mm per pixel. */
  uncertaintyMmPerPixel?: number;
}
export interface SegmentationConfig {
  colorSpace: 'CIELAB';
  targetPhase: PhaseType;
  /** CIELAB (D65) colour of the phase, usually sampled on the reference frame. */
  referenceLab: Lab;
  /** A pixel belongs to the phase when CIEDE2000(pixel, referenceLab) ≤ this value. */
  deltaEThreshold: number;
  roi?: { x: number; y: number; width: number; height: number };
  morphology?: { enabled: boolean; openingRadius: number; closingRadius: number; fillHoles: boolean };
  connectedComponents?: {
    enabled: boolean;
    minimumAreaPixels: number;
    maximumAreaPixels?: number;
    /** After the area filter keep only the single largest connected region (rejects stray blobs). */
    keepLargestOnly?: boolean;
  };
  /** Gain on L*, a*, b* so the frame's median L* equals targetMedianL (compensates uniform exposure drift; clamped to 0.5–2). */
  illumination?: { enabled: boolean; targetMedianL?: number };
  /** Robust vertical bounds: ignore the outermost `low` % / (100−high) % of mask pixels (rows) so specks cannot move the edge. */
  percentileBoundary?: { enabled: boolean; low: number; high: number };
}
export interface ConfidenceParts {
  area: number; continuity: number; compactness: number; colorMargin: number;
  components: number; unknown: number; contrast: number; smoothness: number;
}
export interface ConfidenceConfig {
  /** Results scoring below this are reported as LOW_CONFIDENCE. */
  minimumAcceptable: number;
  weights?: ConfidenceParts;
}
export interface MeasurementDefinition {
  id: string;
  name: string;
  phase: PhaseType;
  /** Only 'HEIGHT' (vertical extent) is implemented; any other value is rejected up front. */
  quantity: 'HEIGHT' | 'SPAN' | 'DISPLACEMENT' | 'ANGLE' | 'AREA' | 'PERIMETER';
  measurementConvention: MeasurementConvention;
  /** Optional: measure height from the top of the phase down to this image row instead of to the bottom of the phase. */
  baselineY?: number;
  segmentation: SegmentationConfig;
}
export interface BatchRecipe {
  algorithmVersion: string;
  calibration: CalibrationConfig;
  measurements: MeasurementDefinition[];
  confidence?: ConfidenceConfig;
  /** Fill MISSING_PHASE frames between two VALID neighbours (status INTERPOLATED). Off unless the user turns it on. */
  allowInterpolation: boolean;
  interpolationMethod?: 'LINEAR' | 'SPLINE';
  preserveMasks?: boolean;
  preserveIntermediateData?: boolean;
}
export interface MeasurementUncertainty {
  calibrationUncertaintyMm: number;
  segmentationUncertaintyMm: number;
  combinedUncertaintyMm: number;
}
export interface MeasurementResult {
  frameIndex: number;
  frameName?: string;
  measurementId: string;
  minY: number | null;
  maxY: number | null;
  centroidY: number | null;
  pixelHeight: number | null;
  physicalHeightMm: number | null;
  /** 0..1, computed from the eight measured quality terms in `confidenceParts` (nothing is a fixed constant). */
  confidence: number;
  confidenceParts?: ConfidenceParts;
  status: MeasurementStatus;
  calibrationScaleMmPerPixel: number;
  algorithmVersion: string;
  measurementConvention: MeasurementConvention;
  uncertainty?: MeasurementUncertainty;
  componentCount?: number;
  areaPixels?: number;
  boundaryContinuity?: number;
  /** Mean CIEDE2000 distance of the pixels inside the mask to the reference colour. */
  meanDeltaE?: number;
  baselineY?: number | null;
  /** Human-readable reasons (e.g. "baseline_not_below_top", "interpolated", error text). */
  notes?: string[];
}
export interface ProcessingAudit {
  experimentId: string;
  algorithmVersion: string;
  frameCount: number;
  validFrameCount: number;
  invalidFrameCount: number;
  calibration: CalibrationConfig;
  segmentationConfig: SegmentationConfig;
  measurementConvention: MeasurementConvention;
  processingStartedAt: string;
  processingCompletedAt: string;
  measurements?: MeasurementDefinition[];
  frameNames?: string[];
  statusCounts?: Record<string, number>;
  warnings?: string[];
}
export interface FrameProcessingResult { results: MeasurementResult[]; masks?: Record<string, PhaseMask>; }
export interface ExperimentResult { results: MeasurementResult[]; audit: ProcessingAudit; }
export interface BatchProgress { done: number; total: number; frameIndex: number; }
