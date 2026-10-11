import { labDistance, type LAB } from "./color";
import { detectRegion, relocateSeed, traceContour, type DetectOptions, type LabField, type Pt, type SegmentResult } from "./segmentation";
import type { Scale } from "./pixmatch";

export type ScientificComponent = {
  id: string;
  label: string;
  referenceLab: LAB;
  pointsRel: Pt[];
  detect: DetectOptions;
  searchRadiusRel: number;
};

export type ScientificPhaseGroup = {
  id: string;
  name: string;
  role: "target" | "secondary";
  components: ScientificComponent[];
};

export type ScientificRecipe = {
  groups: ScientificPhaseGroup[];
  baseline?: { p1Rel: Pt; p2Rel: Pt };
  scale: Scale;
  capturedFrom: string;
  capturedAt: string;
};

export type ScientificFrameResult = {
  phase: string;
  role: "target" | "secondary";
  heightPx: number | null;
  heightPhysical: number | null;
  contactDiameterPx: number | null;
  contactDiameterPhysical: number | null;
  topY: number | null;
  baselineY: number | null;
  componentCount: number;
  confidence: number;
  status: "VALID" | "LOW_CONFIDENCE" | "MISSING_PHASE" | "SEGMENTATION_FAILED";
  contour?: Pt[];
};

export function unionSegments(field: LabField, segments: SegmentResult[]): SegmentResult | null {
  if (!segments.length) return null;
  const n = field.width * field.height;
  const mask = new Uint8Array(n);
  let seedLab = segments[0].seedLab;
  let sumL = 0, sumA = 0, sumB = 0, count = 0;
  for (const seg of segments) {
    for (let i = 0; i < n; i++) if (seg.mask[i] && !mask[i]) {
      mask[i] = 1;
      sumL += field.L[i]; sumA += field.A[i]; sumB += field.B[i]; count++;
    }
  }
  if (!count) return null;
  let minX = field.width, minY = field.height, maxX = 0, maxY = 0, cxs = 0, cys = 0;
  for (let y = 0; y < field.height; y++) for (let x = 0; x < field.width; x++) {
    const i = y * field.width + x;
    if (!mask[i]) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    cxs += x; cys += y;
  }
  const pts = traceContour(mask, field.width, field.height);
  const perimeter = pts.reduce((p, a, i) => {
    const b = pts[(i + 1) % pts.length];
    return p + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0);
  let feretMax = 0;
  for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 200))) {
    for (let j = i + 1; j < pts.length; j += Math.max(1, Math.floor(pts.length / 200))) {
      feretMax = Math.max(feretMax, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
  }
  return {
    mask, width: field.width, height: field.height, contour: pts,
    areaPx: count, perimeterPx: perimeter,
    centroid: { x: cxs / count, y: cys / count },
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    circularity: perimeter ? Math.min(1, 4 * Math.PI * count / (perimeter * perimeter)) : 0,
    feretMax, feretMin: 0,
    meanLab: { L: sumL / count, a: sumA / count, b: sumB / count },
    seedLab,
  };
}

export function baselineYAtX(baseline: ScientificRecipe["baseline"], x: number, fallback: number) {
  if (!baseline) return fallback;
  const { p1Rel: a, p2Rel: b } = baseline;
  const dx = b.x - a.x;
  if (Math.abs(dx) < 1e-9) return a.y;
  const t = (x - a.x) / dx;
  return a.y + (b.y - a.y) * t;
}

export function contactSpan(mask: Uint8Array, width: number, height: number, y: number, band = 2) {
  const yc = Math.max(0, Math.min(height - 1, Math.round(y)));
  let best = { minX: Infinity, maxX: -Infinity, count: 0 };
  for (let yy = Math.max(0, yc - band); yy <= Math.min(height - 1, yc + band); yy++) {
    let minX = Infinity, maxX = -Infinity, count = 0;
    for (let x = 0; x < width; x++) if (mask[yy * width + x]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); count++;
    }
    if (count && maxX - minX > best.maxX - best.minX) best = { minX, maxX, count };
  }
  return Number.isFinite(best.minX) ? { minX: best.minX, maxX: best.maxX, widthPx: best.maxX - best.minX } : null;
}

export function segmentScientificGroup(
  field: LabField,
  group: ScientificPhaseGroup,
  priorSeeds?: Map<string, Pt>,
) {
  const segments: SegmentResult[] = [];
  const nextSeeds = new Map<string, Pt>();
  for (const component of group.components) {
    const rel = component.pointsRel[0];
    const around = priorSeeds?.get(component.id) ?? { x: rel.x * field.width, y: rel.y * field.height };
    const radius = Math.max(4, Math.round(component.searchRadiusRel * Math.max(field.width, field.height)));
    let relocated = relocateSeed(field, component.referenceLab, around, radius, component.detect.metric);
    let seg = detectRegion(field, relocated.seed, component.detect);
    if (!seg) {
      relocated = relocateSeed(field, component.referenceLab, around, radius * 2, component.detect.metric);
      seg = detectRegion(field, relocated.seed, component.detect);
    }
    if (seg) {
      segments.push(seg);
      nextSeeds.set(component.id, seg.centroid);
    }
  }
  return { segment: unionSegments(field, segments), seeds: nextSeeds, componentCount: segments.length };
}

export function calculateScientificHeight(
  segment: SegmentResult,
  recipe: ScientificRecipe,
  scale: Scale,
  group: ScientificPhaseGroup,
  componentCount = 1,
): ScientificFrameResult {
  const baselineY = baselineYAtX(recipe.baseline, segment.centroid.x / segment.width, segment.bbox.y + segment.bbox.h - 1) * segment.height;
  const topY = segment.bbox.y;
  const heightPx = Math.max(0, baselineY - topY);
  const contact = contactSpan(segment.mask, segment.width, segment.height, baselineY, Math.max(1, Math.round(segment.height * 0.004)));
  const heightPhysical = scale.pxPerUnit ? heightPx / scale.pxPerUnit : null;
  const contactDiameterPhysical = scale.pxPerUnit && contact ? contact.widthPx / scale.pxPerUnit : null;
  const coverage = segment.areaPx / Math.max(1, segment.width * segment.height);
  const confidence = Math.max(0, Math.min(1, 0.75 + Math.min(0.25, coverage * 20)));
  return {
    phase: group.name,
    role: group.role,
    heightPx,
    heightPhysical,
    contactDiameterPx: contact?.widthPx ?? null,
    contactDiameterPhysical,
    topY,
    baselineY,
    componentCount,
    confidence,
    status: confidence < 0.5 ? "LOW_CONFIDENCE" : "VALID",
    contour: segment.contour,
  };
}
