import { labDistanceW, rgbToLab, type LAB, type RGB } from "./color";
import { detectRegion, relocateSeedWithSoftPrior, traceContour, type DetectOptions, type LabField, type Pt, type SegmentResult } from "./segmentation";
import type { Scale } from "./pixmatch";

export type ScientificComponent = {
  id: string;
  label: string;
  referenceLab: LAB;
  referenceRgb?: RGB;
  pointsRel: Pt[];
  /** Full traced reference contour in normalized image coordinates for audit/visibility. */
  contourRel?: Pt[];
  detect: DetectOptions;
  searchRadiusRel: number;
};

export type ScientificPhaseGroup = {
  id: string;
  name: string;
  role: "target" | "secondary";
  components: ScientificComponent[];
  traceColor?: string;
  traceWidth?: number;
  traceDashed?: boolean;
  traceVisible?: boolean;
};

/**
 * What a user-drawn reference line means. Roles are physical, not example-specific:
 *  - "height": the line defines the physical measurement axis; the current target phase extent
 *              is recomputed by projection of the current phase mask onto that axis.
 *  - "base":   a reference level. The extent of the target phase (its top boundary to this level)
 *              is measured against it. Requires a target phase.
 *  - "chord":  the width of the target phase mask cut by this line (e.g. a contact span).
 *              Requires a target phase.
 */
export type ScientificLineRole = "height" | "base" | "chord" | "length";

/** Appearance of one endpoint on the reference frame, used to find it again in other frames. */
export type LineAnchor = {
  /** Mean CIELAB / RGB of a small patch at the endpoint. */
  lab: LAB;
  rgb: RGB;
  /** CIELAB samples along the line axis, centred on the endpoint. */
  profile: LAB[];
};

export type ScientificLine = {
  id: string;
  role: ScientificLineRole;
  label: string;
  p1Rel: Pt;
  p2Rel: Pt;
  /** Only for role "height". */
  anchors?: [LineAnchor, LineAnchor];
  searchRadiusRel: number;
  /** 0..1 weight of L* when matching endpoints; <1 tolerates exposure drift. */
  lightnessWeight?: number;
  rgbWeight?: number;
  /** User-given definition of what this line measures (e.g. "Contact diameter"). */
  quantity?: string;
  /** Optional end-keyframe: where the user placed the same line on the LAST frame. */
  endRel?: [Pt, Pt];
  endAnchors?: [LineAnchor, LineAnchor];
};

/**
 * A user-defined three-point angle (arm1 end, vertex, arm2 end). Each point is re-located in every
 * frame from its CIELAB/RGB appearance. If a target phase exists, the angle is refined by fitting the
 * phase boundary tangent at the vertex (the usual contact-angle definition).
 */
export type ScientificAngle = {
  id: string;
  label: string;
  /** What the angle means, e.g. "Contact angle". */
  quantity: string;
  pRel: [Pt, Pt, Pt];
  anchors: [LineAnchor, LineAnchor, LineAnchor];
  searchRadiusRel: number;
  lightnessWeight?: number;
  rgbWeight?: number;
  endRel?: [Pt, Pt, Pt];
  endAnchors?: [LineAnchor, LineAnchor, LineAnchor];
  /** Use the phase-boundary tangent at the vertex (the usual contact-angle definition). */
  useBoundaryTangent: boolean;
  /**
   * Appearance of the region inside the wedge, learned on the reference frame. Used to segment that region in
   * every frame when no target phase is defined, so the contact angle works without a separate phase setup.
   */
  wedge?: { offset: Pt; lab: LAB; detect: DetectOptions };
};

export type ScientificAngleResult = {
  angleId: string;
  label: string;
  p1: Pt | null;
  vertex: Pt | null;
  p2: Pt | null;
  angleDeg: number | null;
  method: "3-point" | "boundary-tangent" | null;
  confidence: number;
  status: "VALID" | "LOW_CONFIDENCE" | "FAILED";
};

export type ScientificInteractionMode = "resolve-overlaps" | "allow-overlaps";

export type ScientificInteractionSettings = {
  mode: ScientificInteractionMode;
  ambiguityMargin: number;
  spatialTieBreak: number;
};

export type ScientificRecipe = {
  groups: ScientificPhaseGroup[];
  interaction: ScientificInteractionSettings;
  /** Only the lines the user defined on the reference frame; nothing else is measured. */
  lines: ScientificLine[];
  /** User-defined angles (contact angle etc.), tracked in every frame. */
  angles?: ScientificAngle[];
  scale: Scale;
  capturedFrom: string;
  capturedAt: string;
};

export type ScientificLineResult = {
  lineId: string;
  label: string;
  p1: Pt | null;
  p2: Pt | null;
  lengthPx: number | null;
  lengthPhysical: number | null;
  confidence: number;
  status: "VALID" | "LOW_CONFIDENCE" | "FAILED";
};

export type ScientificFrameResult = {
  phase: string;
  role: "target" | "secondary";
  heightPx: number | null;
  heightPhysical: number | null;
  contactDiameterPx: number | null;
  contactDiameterPhysical: number | null;
  topY: number | null;
  bottomY: number | null;
  pixelHeight: number | null;
  baselineY: number | null;
  componentCount: number;
  confidence: number;
  status: "VALID" | "LOW_CONFIDENCE" | "MISSING_PHASE" | "SEGMENTATION_FAILED" | "INVALID_FRAME";
  contour?: Pt[];
  interaction?: { overlapPixels: number; ambiguousPixels: number; resolvedPixels: number; competingPhases: string[] };
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

export function lineYAtX(line: ScientificLine, xRel: number, fallback: number) {
  const a = line.p1Rel, b = line.p2Rel;
  const dx = b.x - a.x;
  if (Math.abs(dx) < 1e-9) return a.y;
  return a.y + (b.y - a.y) * ((xRel - a.x) / dx);
}

/**
 * Width of a mask along an arbitrary line (extended across the image), tolerant to a thin
 * perpendicular band so a line lying exactly on the mask boundary still registers.
 */
export function chordSpan(mask: Uint8Array, width: number, height: number, a: Pt, b: Pt, band = 2) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return null;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const nx = -uy, ny = ux;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const reach = width + height;
  let best: number | null = null;
  for (let o = -band; o <= band; o++) {
    let tMin = Infinity, tMax = -Infinity;
    for (let t = -reach; t <= reach; t += 0.5) {
      const x = Math.round(mx + ux * t + nx * o), y = Math.round(my + uy * t + ny * o);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (mask[y * width + x]) { tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }
    }
    if (Number.isFinite(tMin) && (best == null || tMax - tMin > best)) best = tMax - tMin;
  }
  return best;
}

/* ---------------- line endpoint learning + tracking (role "height") ---------------- */

/** Bilinear CIELAB sample so endpoints can be located to sub-pixel precision. */
function labAt(field: LabField, x: number, y: number): LAB {
  const fx = Math.max(0, Math.min(field.width - 1, x));
  const fy = Math.max(0, Math.min(field.height - 1, y));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(field.width - 1, x0 + 1), y1 = Math.min(field.height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const at = (xx: number, yy: number, arr: Float32Array) => arr[yy * field.width + xx];
  const mix = (arr: Float32Array) =>
    (at(x0, y0, arr) * (1 - tx) + at(x1, y0, arr) * tx) * (1 - ty) +
    (at(x0, y1, arr) * (1 - tx) + at(x1, y1, arr) * tx) * ty;
  return { L: mix(field.L), a: mix(field.A), b: mix(field.B) };
}

function axisHalfWindow(lengthPx: number) {
  return Math.max(4, Math.min(12, Math.round(lengthPx * 0.03)));
}

/** Learn what one point looks like on a frame: CIELAB profile along an axis + local RGB. */
export function captureAnchorAt(field: LabField, image: ImageData, c: Pt, ux: number, uy: number, w: number): LineAnchor {
  const profile: LAB[] = [];
  for (let t = -w; t <= w; t++) profile.push(labAt(field, c.x + ux * t, c.y + uy * t));
  let r = 0, g = 0, bl = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = Math.max(0, Math.min(image.width - 1, Math.round(c.x) + dx));
    const y = Math.max(0, Math.min(image.height - 1, Math.round(c.y) + dy));
    const o = (y * image.width + x) * 4;
    r += image.data[o]; g += image.data[o + 1]; bl += image.data[o + 2]; n++;
  }
  const rgb = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(bl / n) };
  return { lab: rgbToLab(rgb.r, rgb.g, rgb.b), rgb, profile };
}

/** Learn what each endpoint of a line looks like on the reference frame (CIELAB + RGB). */
export function captureLineAnchors(field: LabField, image: ImageData, a: Pt, b: Pt): [LineAnchor, LineAnchor] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const w = axisHalfWindow(len);
  return [captureAnchorAt(field, image, a, ux, uy, w), captureAnchorAt(field, image, b, ux, uy, w)];
}

/** Learn the three points of an angle. Arm 1 (vertex → point 1) is the axis used for points 1 and the vertex. */
export function captureAngleAnchors(field: LabField, image: ImageData, p: [Pt, Pt, Pt]): [LineAnchor, LineAnchor, LineAnchor] {
  const [a, v, b] = p;
  const l1 = Math.hypot(a.x - v.x, a.y - v.y) || 1, l2 = Math.hypot(b.x - v.x, b.y - v.y) || 1;
  const u1 = { x: (a.x - v.x) / l1, y: (a.y - v.y) / l1 }, u2 = { x: (b.x - v.x) / l2, y: (b.y - v.y) / l2 };
  const w = axisHalfWindow(Math.min(l1, l2));
  return [captureAnchorAt(field, image, a, u1.x, u1.y, w), captureAnchorAt(field, image, v, u1.x, u1.y, w), captureAnchorAt(field, image, b, u2.x, u2.y, w)];
}

/** Per-sample ΔE is clipped so an occluder or glare spot cannot dominate the match. */
const COST_CLIP = 30;

function locateEndpoint(
  field: LabField, anchor: LineAnchor, around: Pt, ux: number, uy: number, radiusPx: number, lightnessWeight: number, rgbWeight = 0.2,
): { p: Pt; cost: number } {
  const w = (anchor.profile.length - 1) / 2;
  const nx = -uy, ny = ux;
  const lateral = Math.max(2, Math.round(radiusPx * 0.25));
  const costAt = (s: number, l: number) => {
    const cx = around.x + ux * s + nx * l, cy = around.y + uy * s + ny * l;
    if (cx < 0 || cy < 0 || cx > field.width - 1 || cy > field.height - 1) return Infinity;
    let cost = 0;
    for (let t = -w; t <= w; t++) {
      let sum = 0;
      for (let o = -1; o <= 1; o++) {
        const sx = Math.max(0, Math.min(field.width - 1, Math.round(cx + ux * t + nx * o)));
        const sy = Math.max(0, Math.min(field.height - 1, Math.round(cy + uy * t + ny * o)));
        const lab = labAt(field, sx, sy);
        const i = sy * field.width + sx;
        const rgbD = Math.hypot(field.R[i] - anchor.rgb.r, field.G[i] - anchor.rgb.g, field.B8[i] - anchor.rgb.b) / Math.sqrt(3 * 255 * 255) * 100;
        const labD = labDistanceW(anchor.profile[t + w], lab, "cie76", lightnessWeight);
        sum += Math.min(COST_CLIP, (1 - rgbWeight) * labD + rgbWeight * rgbD);
      }
      cost += sum / 3;
    }
    return cost / anchor.profile.length;
  };
  // Coarse integer search with a small preference for staying near the previous position.
  let best = { s: 0, l: 0, cost: Infinity };
  for (let l = -lateral; l <= lateral; l++) {
    for (let s = -radiusPx; s <= radiusPx; s++) {
      const c = costAt(s, l);
      if (!Number.isFinite(c)) continue;
      const biased = c + 0.5 * (Math.abs(s) + Math.abs(l)) / Math.max(1, radiusPx);
      if (biased < best.cost) best = { s, l, cost: biased };
    }
  }
  if (!Number.isFinite(best.cost)) return { p: around, cost: Infinity };
  // Sub-pixel refinement: parabola through the cost at s-1, s, s+1 along the axis.
  let sSub = best.s;
  const cm = costAt(best.s - 1, best.l), c0 = costAt(best.s, best.l), cp = costAt(best.s + 1, best.l);
  if (Number.isFinite(cm) && Number.isFinite(c0) && Number.isFinite(cp)) {
    const denom = cm - 2 * c0 + cp;
    if (denom > 1e-6) sSub = best.s + Math.max(-0.5, Math.min(0.5, (0.5 * (cm - cp)) / denom));
  }
  return { p: { x: around.x + ux * sSub + nx * best.l, y: around.y + uy * sSub + ny * best.l }, cost: costAt(best.s, best.l) };
}

const lerpPt = (p: Pt, q: Pt, t: number): Pt => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

/** Locate a point with every anchor available (frame-1 look, last-frame look) and keep the better match. */
function locateWithAnchors(
  field: LabField, anchors: LineAnchor[], around: Pt, ux: number, uy: number, radiusPx: number, lw: number, rw: number,
) {
  let best: { p: Pt; cost: number } | null = null;
  for (const anchor of anchors) {
    const hit = locateEndpoint(field, anchor, around, ux, uy, radiusPx, lw, rw);
    if (!best || hit.cost < best.cost) best = hit;
  }
  return best ?? { p: around, cost: Infinity };
}

/**
 * Re-locate both endpoints of a tracked line (roles "height" and "length") in another frame.
 * `t` is the frame's position (0 = first, 1 = last) used to interpolate toward an optional last-frame keyframe.
 */
export function trackHeightLine(
  field: LabField,
  line: ScientificLine,
  scale: Scale,
  prior?: [Pt, Pt],
  t = 0,
): { result: ScientificLineResult; endpoints: [Pt, Pt] | null } {
  const a0 = { x: line.p1Rel.x * field.width, y: line.p1Rel.y * field.height };
  const b0 = { x: line.p2Rel.x * field.width, y: line.p2Rel.y * field.height };
  const fail = (): { result: ScientificLineResult; endpoints: null } => ({
    result: { lineId: line.id, label: line.label, p1: null, p2: null, lengthPx: null, lengthPhysical: null, confidence: 0, status: "FAILED" },
    endpoints: null,
  });
  if (!line.anchors) return fail();
  const hasEnd = Boolean(line.endRel && line.endAnchors);
  const aE = hasEnd ? { x: line.endRel![0].x * field.width, y: line.endRel![0].y * field.height } : a0;
  const bE = hasEnd ? { x: line.endRel![1].x * field.width, y: line.endRel![1].y * field.height } : b0;
  // With a last-frame keyframe the expected position is interpolated between the two hand-placed lines.
  const centreA = hasEnd ? lerpPt(a0, aE, t) : (prior?.[0] ?? a0);
  const centreB = hasEnd ? lerpPt(b0, bE, t) : (prior?.[1] ?? b0);
  const axisA = hasEnd ? centreA : a0, axisB = hasEnd ? centreB : b0;
  const len = Math.hypot(axisB.x - axisA.x, axisB.y - axisA.y);
  if (len < 1e-6) return fail();
  const ux = (axisB.x - axisA.x) / len, uy = (axisB.y - axisA.y) / len;
  const radiusPx = Math.max(4, Math.round(line.searchRadiusRel * Math.max(field.width, field.height)));
  const lw = line.lightnessWeight ?? 1;
  const rw = line.rgbWeight ?? 0.2;
  const anchorsA = [line.anchors[0], ...(line.endAnchors ? [line.endAnchors[0]] : [])];
  const anchorsB = [line.anchors[1], ...(line.endAnchors ? [line.endAnchors[1]] : [])];
  const A = locateWithAnchors(field, anchorsA, centreA, ux, uy, radiusPx, lw, rw);
  const B = locateWithAnchors(field, anchorsB, centreB, ux, uy, radiusPx, lw, rw);
  if (!Number.isFinite(A.cost) || !Number.isFinite(B.cost)) return fail();
  const lengthPx = Math.hypot(B.p.x - A.p.x, B.p.y - A.p.y);
  const confidence = Math.max(0, Math.min(1, 1 - Math.max(A.cost, B.cost) / 30));
  return {
    result: {
      lineId: line.id, label: line.label, p1: A.p, p2: B.p,
      lengthPx,
      lengthPhysical: scale.pxPerUnit ? lengthPx / scale.pxPerUnit : null,
      confidence,
      status: lengthPx < 1 ? "FAILED" : confidence < 0.5 ? "LOW_CONFIDENCE" : "VALID",
    },
    endpoints: [A.p, B.p],
  };
}

/** Interior angle (degrees) at `v` between rays v→a and v→b. */
export function angleAt(a: Pt, v: Pt, b: Pt) {
  const ax = a.x - v.x, ay = a.y - v.y, bx = b.x - v.x, by = b.y - v.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return null;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * Contact angle from the boundary of a segmented phase at a contact point. Boundary pixels of `mask` within
 * `radius` of the vertex and on the arm-2 side of arm 1 are fitted with a line; the angle to arm 1 is returned.
 * The fit is repeated at half the radius and extrapolated to zero radius to remove curvature (chord) bias.
 * Returns null if too few boundary pixels exist.
 */
export function boundaryTangentAngle(
  mask: Uint8Array, width: number, height: number, vertex: Pt, arm1: Pt, arm2Side: Pt, radius: number,
): number | null {
  const l1 = Math.hypot(arm1.x - vertex.x, arm1.y - vertex.y);
  if (l1 < 1e-6) return null;
  const ux = (arm1.x - vertex.x) / l1, uy = (arm1.y - vertex.y) / l1;
  const side = Math.sign(ux * (arm2Side.y - vertex.y) - uy * (arm2Side.x - vertex.x)) || 1;

  const fit = (rad: number): number | null => {
    const x0 = Math.max(1, Math.floor(vertex.x - rad)), x1 = Math.min(width - 2, Math.ceil(vertex.x + rad));
    const y0 = Math.max(1, Math.floor(vertex.y - rad)), y1 = Math.min(height - 2, Math.ceil(vertex.y + rad));
    let sxx = 0, sxy = 0, syy = 0, n = 0, cx = 0, cy = 0;
    const minD = Math.max(2, rad * 0.12);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (mask[i - 1] && mask[i + 1] && mask[i - width] && mask[i + width]) continue; // interior pixel
      const dx = x - vertex.x, dy = y - vertex.y;
      const d = Math.hypot(dx, dy);
      if (d < minD || d > rad) continue;
      const s = (ux * dy - uy * dx) * side; // signed distance from the arm-1 line, positive on arm-2 side
      // Skip boundary pixels that merely run along the solid surface (arm 1).
      if (s < Math.max(2.5, 0.12 * d)) continue;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy; cx += dx; cy += dy; n++;
    }
    if (n < 8) return null;
    // Total-least-squares line through the interface pixels (centred), tolerant of small vertex error.
    const mx = cx / n, my = cy / n;
    const cxx = sxx / n - mx * mx, cxy = sxy / n - mx * my, cyy = syy / n - my * my;
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let ex = Math.cos(theta), ey = Math.sin(theta);
    if (ex * mx + ey * my < 0) { ex = -ex; ey = -ey; }
    const c = Math.max(-1, Math.min(1, ex * ux + ey * uy));
    return (Math.acos(c) * 180) / Math.PI;
  };

  const wide = fit(radius);
  if (wide == null) return null;
  // A straight-line fit over a curved interface measures a chord, not the tangent. The chord error grows
  // roughly linearly with the fitting radius, so extrapolate the radius → 0 using a half-radius fit.
  const narrow = radius >= 16 ? fit(radius / 2) : null;
  if (narrow == null) return wide;
  const tangent = 2 * narrow - wide;
  // Guard against noise: never move more than 20° away from the wide-fit value.
  return Math.max(0, Math.min(180, Math.abs(tangent - wide) > 20 ? wide : tangent));
}

/** Learn what the region inside an angle's wedge looks like, so it can be segmented in every frame. */
export function captureWedge(field: LabField, p: [Pt, Pt, Pt], detect: DetectOptions): ScientificAngle["wedge"] | undefined {
  const [a, v, b] = p;
  const l1 = Math.hypot(a.x - v.x, a.y - v.y), l2 = Math.hypot(b.x - v.x, b.y - v.y);
  if (l1 < 1e-6 || l2 < 1e-6) return undefined;
  let bx = (a.x - v.x) / l1 + (b.x - v.x) / l2, by = (a.y - v.y) / l1 + (b.y - v.y) / l2;
  const bl = Math.hypot(bx, by);
  if (bl < 1e-6) return undefined;
  bx /= bl; by /= bl;
  const reach = 0.4 * Math.min(l1, l2);
  const offset = { x: bx * reach, y: by * reach };
  const sx = Math.round(v.x + offset.x), sy = Math.round(v.y + offset.y);
  if (sx < 0 || sy < 0 || sx >= field.width || sy >= field.height) return undefined;
  const i = sy * field.width + sx;
  return { offset, lab: { L: field.L[i], a: field.A[i], b: field.B[i] }, detect };
}

/** Re-locate the three points of a user-defined angle and compute the angle in this frame. */
export function trackAngle(
  field: LabField,
  angle: ScientificAngle,
  prior?: [Pt, Pt, Pt],
  t = 0,
  targetMask?: { mask: Uint8Array; width: number; height: number } | null,
): { result: ScientificAngleResult; points: [Pt, Pt, Pt] | null } {
  const toPx = (p: Pt): Pt => ({ x: p.x * field.width, y: p.y * field.height });
  const fail = (): { result: ScientificAngleResult; points: null } => ({
    result: { angleId: angle.id, label: angle.label, p1: null, vertex: null, p2: null, angleDeg: null, method: null, confidence: 0, status: "FAILED" },
    points: null,
  });
  const ref = angle.pRel.map(toPx) as [Pt, Pt, Pt];
  const hasEnd = Boolean(angle.endRel && angle.endAnchors);
  const end = hasEnd ? (angle.endRel!.map(toPx) as [Pt, Pt, Pt]) : ref;
  const centres = ref.map((p, i) => (hasEnd ? lerpPt(p, end[i], t) : (prior?.[i] ?? p))) as [Pt, Pt, Pt];
  const axisPts = hasEnd ? centres : ref;
  const l1 = Math.hypot(axisPts[0].x - axisPts[1].x, axisPts[0].y - axisPts[1].y);
  const l2 = Math.hypot(axisPts[2].x - axisPts[1].x, axisPts[2].y - axisPts[1].y);
  if (l1 < 1e-6 || l2 < 1e-6) return fail();
  const u1 = { x: (axisPts[0].x - axisPts[1].x) / l1, y: (axisPts[0].y - axisPts[1].y) / l1 };
  const u2 = { x: (axisPts[2].x - axisPts[1].x) / l2, y: (axisPts[2].y - axisPts[1].y) / l2 };
  const axes = [u1, u1, u2];
  const radiusPx = Math.max(4, Math.round(angle.searchRadiusRel * Math.max(field.width, field.height)));
  const lw = angle.lightnessWeight ?? 1, rw = angle.rgbWeight ?? 0.2;
  const hits = centres.map((c, i) =>
    locateWithAnchors(field, [angle.anchors[i], ...(angle.endAnchors ? [angle.endAnchors[i]] : [])], c, axes[i].x, axes[i].y, radiusPx, lw, rw));
  if (hits.some((h) => !Number.isFinite(h.cost))) return fail();
  const pts = hits.map((h) => h.p) as [Pt, Pt, Pt];
  let deg = angleAt(pts[0], pts[1], pts[2]);
  if (deg == null) return fail();
  let method: "3-point" | "boundary-tangent" = "3-point";
  if (angle.useBoundaryTangent) {
    let region: { mask: Uint8Array; width: number; height: number } | null = targetMask ?? null;
    if (!region && angle.wedge) {
      const seed = { x: pts[1].x + angle.wedge.offset.x, y: pts[1].y + angle.wedge.offset.y };
      const sx = Math.round(seed.x), sy = Math.round(seed.y);
      if (sx >= 0 && sy >= 0 && sx < field.width && sy < field.height) {
        const i = sy * field.width + sx;
        const here = { L: field.L[i], a: field.A[i], b: field.B[i] };
        // Only trust the wedge region if the seed still looks like it did on the reference frame.
        if (labDistanceW(angle.wedge.lab, here, "cie76", lw) <= Math.max(20, angle.wedge.detect.tolerance * 1.5)) {
          const seg = detectRegion(field, seed, angle.wedge.detect);
          if (seg) region = { mask: seg.mask, width: seg.width, height: seg.height };
        }
      }
    }
    if (region) {
      const reach = Math.max(10, 0.5 * Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y));
      const tan = boundaryTangentAngle(region.mask, region.width, region.height, pts[1], pts[0], pts[2], reach);
      if (tan != null) { deg = tan; method = "boundary-tangent"; }
    }
  }
  const confidence = Math.max(0, Math.min(1, 1 - Math.max(...hits.map((h) => h.cost)) / 30));
  return {
    result: {
      angleId: angle.id, label: angle.label, p1: pts[0], vertex: pts[1], p2: pts[2], angleDeg: deg, method,
      confidence, status: confidence < 0.5 ? "LOW_CONFIDENCE" : "VALID",
    },
    points: pts,
  };
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
    const referencePoint = { x: rel.x * field.width, y: rel.y * field.height };
    const priorPoint = priorSeeds?.get(component.id);
    const radius = Math.max(4, Math.round(component.searchRadiusRel * Math.max(field.width, field.height)));
    let relocated = relocateSeedWithSoftPrior(field, component.referenceLab, referencePoint, priorPoint, radius, component.detect.metric, component.detect.lightnessWeight ?? 1, component.referenceRgb, component.detect.rgbWeight ?? 0.2);
    let seg = detectRegion(field, relocated.seed, component.detect);
    if (!seg) {
      // Retry from the reference location with a wider search, not by expanding
      // an accumulated previous-frame mask.
      relocated = relocateSeedWithSoftPrior(field, component.referenceLab, referencePoint, priorPoint, radius * 2, component.detect.metric, component.detect.lightnessWeight ?? 1, component.referenceRgb, component.detect.rgbWeight ?? 0.2);
      seg = detectRegion(field, relocated.seed, component.detect);
    }
    if (seg) {
      segments.push(seg);
      nextSeeds.set(component.id, seg.centroid);
    }
  }
  return { segment: unionSegments(field, segments), seeds: nextSeeds, componentCount: segments.length, segments };
}

function rgbDist100(a: RGB, b: RGB) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) / Math.sqrt(3 * 255 * 255) * 100;
}

function pixelRgb(field: LabField, i: number): RGB {
  return { r: field.R[i], g: field.G[i], b: field.B8[i] };
}

function componentScore(field: LabField, i: number, component: ScientificComponent, seed: Pt) {
  const lab: LAB = { L: field.L[i], a: field.A[i], b: field.B[i] };
  const labD = labDistanceW(lab, component.referenceLab, component.detect.metric, component.detect.lightnessWeight ?? 1);
  const rgbD = component.referenceRgb ? rgbDist100(pixelRgb(field, i), component.referenceRgb) : 0;
  const rw = Math.max(0, Math.min(1, component.detect.rgbWeight ?? 0.2));
  const colour = (1 - rw) * labD + rw * rgbD;
  const maxDim = Math.max(field.width, field.height);
  const spatial = Math.hypot((i % field.width) - seed.x, Math.floor(i / field.width) - seed.y) / maxDim;
  return { score: colour + spatial * 100 * 0.08, colour };
}

/**
 * Resolve pixels claimed by multiple independently traced CIELAB surfaces.
 * This matters when two physical phases touch or temporarily overlap in colour space:
 * each component is first detected independently, then ambiguous shared pixels are
 * assigned to the phase with the strongest reference-colour + spatial evidence.
 */
export function segmentScientificGroups(
  field: LabField,
  groups: ScientificPhaseGroup[],
  priorSeeds?: Map<string, Pt>,
  interaction: ScientificInteractionSettings = { mode: "resolve-overlaps", ambiguityMargin: 1.5, spatialTieBreak: 0.08 },
) {
  const found = groups.map((group) => ({ group, ...segmentScientificGroup(field, group, priorSeeds) }));
  const n = field.width * field.height;
  const masks = found.map((f) => f.segment?.mask ?? new Uint8Array(n));
  const owner = new Int16Array(n); owner.fill(-1);
  const overlapCount = new Uint8Array(n);
  let overlapPixels = 0, ambiguousPixels = 0, resolvedPixels = 0;
  const competing = new Set<string>();

  if (interaction.mode === "allow-overlaps") {
    return { found, interaction: { overlapPixels: 0, ambiguousPixels: 0, resolvedPixels: 0, competingPhases: [] as string[] } };
  }

  for (let i = 0; i < n; i++) {
    const candidates: number[] = [];
    for (let g = 0; g < masks.length; g++) if (masks[g][i]) candidates.push(g);
    if (!candidates.length) continue;
    if (candidates.length === 1) { owner[i] = candidates[0]; continue; }
    overlapPixels++;
    candidates.forEach((g) => competing.add(found[g].group.name));

    let best = -1, bestScore = Infinity, second = Infinity;
    for (const g of candidates) {
      const f = found[g];
      let localBest = Infinity;
      for (const component of f.group.components) {
        const seed = f.seeds.get(component.id) ?? { x: component.pointsRel[0].x * field.width, y: component.pointsRel[0].y * field.height };
        localBest = Math.min(localBest, componentScore(field, i, component, seed).score);
      }
      if (localBest < bestScore) { second = bestScore; bestScore = localBest; best = g; }
      else if (localBest < second) second = localBest;
    }
    const margin = Math.max(0, interaction.ambiguityMargin);
    if (Number.isFinite(second) && second - bestScore < margin) ambiguousPixels++;
    owner[i] = best;
    resolvedPixels++;
  }

  // Rebuild each phase mask using the conflict-resolved ownership. Pixels unique to a phase
  // remain untouched; only competing pixels are reassigned.
  for (let g = 0; g < found.length; g++) {
    const original = found[g].segment;
    if (!original) continue;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (masks[g][i] && owner[i] === g) mask[i] = 1;
    // Keep a phase alive if conflict resolution consumed everything; this is a hard failure,
    // not a reason to fabricate a region.
    if (!mask.some(Boolean)) { found[g].segment = null; continue; }
    const rebuilt = unionSegments(field, [{ ...original, mask }]);
    found[g].segment = rebuilt;
  }

  return { found, interaction: { overlapPixels, ambiguousPixels, resolvedPixels, competingPhases: [...competing] } };
}

/**
 * Phase-level quantities. Only what the user defined on the reference frame is computed:
 * extent needs a "base" line, span needs a "chord" line; without them the field stays null.
 */
export function extentAlongAxis(mask: Uint8Array, width: number, height: number, a: Pt, b: Pt) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return null;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  let minT = Infinity, maxT = -Infinity;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    const t = (x - cx) * ux + (y - cy) * uy;
    minT = Math.min(minT, t); maxT = Math.max(maxT, t);
  }
  return Number.isFinite(minT) ? maxT - minT : null;
}

export function verticalBounds(mask: Uint8Array, width: number, height: number) {
  let minY = height, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxY < 0 ? null : { minY, maxY, pixelHeight: maxY - minY };
}

export function measureScientificPhase(
  segment: SegmentResult,
  recipe: ScientificRecipe,
  scale: Scale,
  group: ScientificPhaseGroup,
  componentCount = 1,
): ScientificFrameResult {
  const heightLine = recipe.lines.find((l) => l.role === "height");
  const baseLine = recipe.lines.find((l) => l.role === "base");
  const chordLine = recipe.lines.find((l) => l.role === "chord");
  const bounds = verticalBounds(segment.mask, segment.width, segment.height);
  const topY = bounds?.minY ?? null;
  const bottomY = bounds?.maxY ?? null;
  const pixelHeight = bounds?.pixelHeight ?? null;
  let baselineY: number | null = null;
  let heightPx: number | null = null;
  if (heightLine) {
    heightPx = extentAlongAxis(
      segment.mask, segment.width, segment.height,
      { x: heightLine.p1Rel.x * segment.width, y: heightLine.p1Rel.y * segment.height },
      { x: heightLine.p2Rel.x * segment.width, y: heightLine.p2Rel.y * segment.height },
    );
  } else if (baseLine) {
    baselineY = lineYAtX(baseLine, segment.centroid.x / segment.width, 0) * segment.height;
    heightPx = topY == null ? null : Math.max(0, baselineY - topY);
  } else {
    // If no semantic axis/base line was defined, expose the measured vertical
    // bounding height instead of inventing another reference geometry.
    heightPx = pixelHeight;
  }
  let spanPx: number | null = null;
  if (chordLine) {
    spanPx = chordSpan(
      segment.mask, segment.width, segment.height,
      { x: chordLine.p1Rel.x * segment.width, y: chordLine.p1Rel.y * segment.height },
      { x: chordLine.p2Rel.x * segment.width, y: chordLine.p2Rel.y * segment.height },
      Math.max(1, Math.round(segment.height * 0.004)),
    );
  }
  const coverage = segment.areaPx / Math.max(1, segment.width * segment.height);
  const confidence = Math.max(0, Math.min(1, 0.75 + Math.min(0.25, coverage * 20)));
  return {
    phase: group.name,
    role: group.role,
    heightPx,
    heightPhysical: heightPx != null && scale.pxPerUnit ? heightPx / scale.pxPerUnit : null,
    contactDiameterPx: spanPx,
    contactDiameterPhysical: spanPx != null && scale.pxPerUnit ? spanPx / scale.pxPerUnit : null,
    topY,
    bottomY,
    pixelHeight,
    baselineY,
    componentCount,
    confidence,
    status: confidence < 0.5 ? "LOW_CONFIDENCE" : "VALID",
    contour: segment.contour,
  };
}
