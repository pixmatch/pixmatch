/**
 * CIELAB boundary detection engine.
 *
 * Phase 1  seed sampling   — average LAB of a small patch under the user click
 * Phase 2  region growing  — flood fill constrained by a ΔE tolerance in LAB
 * Phase 3  morphology      — close/open to remove speckle and pinholes
 * Phase 4  contour trace   — Moore-neighbour boundary walk of the largest blob
 * Phase 5  descriptors     — area, perimeter, centroid, bbox, circularity, Feret
 */

import { labDistance, labDistanceW, rgbToLab, type LAB } from "./color";

export type Pt = { x: number; y: number };

export type SegmentResult = {
  mask: Uint8Array;
  width: number;
  height: number;
  contour: Pt[];
  areaPx: number;
  perimeterPx: number;
  centroid: Pt;
  bbox: { x: number; y: number; w: number; h: number };
  circularity: number;
  feretMax: number;
  feretMin: number;
  meanLab: LAB;
  seedLab: LAB;
};

export type ChannelId = "gray" | "L" | "a" | "b" | "R" | "G" | "B";
export const CHANNELS: Record<ChannelId, { label: string; min: number; max: number }> = {
  gray: { label: "Gray", min: 0, max: 255 },
  L: { label: "L*", min: 0, max: 100 },
  a: { label: "a*", min: -128, max: 127 },
  b: { label: "b*", min: -128, max: 127 },
  R: { label: "R", min: 0, max: 255 },
  G: { label: "G", min: 0, max: 255 },
  B: { label: "B", min: 0, max: 255 },
};
/** Optional hard windows per CIELAB channel (learned from the histogram). Pixels outside are rejected. */
export type ChannelLimits = Partial<Record<"L" | "a" | "b" | "R" | "G" | "B", [number, number]>>;

export type DetectOptions = {
  tolerance: number; // ΔE threshold
  metric: "cie76" | "ciede2000";
  seedRadius: number; // px patch radius for seed averaging
  connectivity: 4 | 8;
  smooth: number; // morphological iterations
  fillHoles: boolean;
  /** 0..1 — weight of L* in ΔE. <1 tolerates exposure drift between frames. Default 1. */
  lightnessWeight?: number;
  /** Histogram-derived windows applied on top of the colour distance. */
  channelLimits?: ChannelLimits | null;
  /** 0..1 contribution of normalized RGB distance to the detection score. */
  rgbWeight?: number;
  /** 0..100 normalized RGB distance tolerance. */
  rgbTolerance?: number;
};

export const DEFAULT_DETECT: DetectOptions = {
  tolerance: 12,
  metric: "ciede2000",
  seedRadius: 3,
  connectivity: 8,
  smooth: 1,
  fillHoles: true,
  lightnessWeight: 1,
  channelLimits: null,
  rgbWeight: 0.2,
  rgbTolerance: 18,
};

/** Cache the LAB conversion of an ImageData so repeated growth is cheap. */
export function toLabField(data: ImageData) {
  const n = data.width * data.height;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const R = new Uint8Array(n);
  const G = new Uint8Array(n);
  const BB = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const lab = rgbToLab(data.data[p], data.data[p + 1], data.data[p + 2]);
    L[i] = lab.L;
    A[i] = lab.a;
    B[i] = lab.b;
    R[i] = data.data[p]; G[i] = data.data[p + 1]; BB[i] = data.data[p + 2];
  }
  return { L, A, B, R, G, B8: BB, width: data.width, height: data.height };
}

export type LabField = ReturnType<typeof toLabField>;

/**
 * Average the LAB of a patch, but only over pixels that already resemble the
 * centre pixel. Without this gate a seed dropped near an edge averages both
 * phases and the region grow immediately rejects its own seed.
 */
export function sampleSeed(
  field: LabField,
  seed: Pt,
  radius: number,
  gate?: { tolerance: number; metric: "cie76" | "ciede2000" },
): LAB {
  const cx = Math.max(0, Math.min(field.width - 1, Math.round(seed.x)));
  const cy = Math.max(0, Math.min(field.height - 1, Math.round(seed.y)));
  const ci = cy * field.width + cx;
  const centre: LAB = { L: field.L[ci], a: field.A[ci], b: field.B[ci] };
  if (radius <= 0) return centre;

  let L = 0, a = 0, b = 0, n = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
      const i = y * field.width + x;
      const lab: LAB = { L: field.L[i], a: field.A[i], b: field.B[i] };
      if (gate && labDistance(lab, centre, gate.metric) > gate.tolerance) continue;
      L += lab.L;
      a += lab.a;
      b += lab.b;
      n++;
    }
  }
  return n ? { L: L / n, a: a / n, b: b / n } : centre;
}

/** Local colour spread around a pixel — low values mean a flat, safe seed. */
function localSpread(
  field: LabField,
  x: number,
  y: number,
  radius: number,
  metric: "cie76" | "ciede2000",
) {
  const ci = y * field.width + x;
  const centre: LAB = { L: field.L[ci], a: field.A[ci], b: field.B[ci] };
  let sum = 0, n = 0;
  for (let yy = y - radius; yy <= y + radius; yy += 1) {
    for (let xx = x - radius; xx <= x + radius; xx += 1) {
      if (xx < 0 || yy < 0 || xx >= field.width || yy >= field.height) continue;
      const i = yy * field.width + xx;
      sum += labDistance({ L: field.L[i], a: field.A[i], b: field.B[i] }, centre, metric);
      n++;
    }
  }
  return n ? sum / n : 0;
}


function dilate(mask: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(mask);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      if (
        (x > 0 && mask[i - 1]) ||
        (x < w - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - w]) ||
        (y < h - 1 && mask[i + w])
      )
        out[i] = 1;
    }
  return out;
}

function erode(mask: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(mask);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      if (
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]
      )
        out[i] = 0;
    }
  return out;
}

/** Fill interior holes by flooding the background from the border. */
function fillHoles(mask: Uint8Array, w: number, h: number) {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    stack.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w, y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    if (i < 0 || i >= w * h || outside[i] || mask[i]) continue;
    outside[i] = 1;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    stack.push(i - w, i + w);
  }
  const out = new Uint8Array(mask);
  for (let i = 0; i < out.length; i++) if (!outside[i]) out[i] = 1;
  return out;
}

/** Moore-neighbour contour trace starting from the topmost-left mask pixel. */
export function traceContour(mask: Uint8Array, w: number, h: number): Pt[] {
  let start = -1;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      start = i;
      break;
    }
  if (start < 0) return [];
  const sx = start % w;
  const sy = Math.floor(start / w);
  const dirs = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

  const contour: Pt[] = [];
  let cx = sx, cy = sy, dir = 6;
  const maxSteps = w * h * 4;
  for (let step = 0; step < maxSteps; step++) {
    contour.push({ x: cx, y: cy });
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (cx === sx && cy === sy && contour.length > 2) break;
  }
  return contour;
}

function polygonPerimeter(pts: Pt[]) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

function feret(pts: Pt[]) {
  let max = 0;
  const step = Math.max(1, Math.floor(pts.length / 240));
  for (let i = 0; i < pts.length; i += step)
    for (let j = i + step; j < pts.length; j += step) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > max) max = d;
    }
  // Min Feret via rotating projections
  let min = Infinity;
  for (let deg = 0; deg < 180; deg += 2) {
    const t = (deg * Math.PI) / 180;
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      const proj = p.x * Math.cos(t) + p.y * Math.sin(t);
      if (proj < lo) lo = proj;
      if (proj > hi) hi = proj;
    }
    min = Math.min(min, hi - lo);
  }
  return { feretMax: max, feretMin: Number.isFinite(min) ? min : 0 };
}

/** Full detection pipeline from a seed point. */
function rgbFromSeed(field: LabField, p: Pt) {
  const x = Math.max(0, Math.min(field.width - 1, Math.round(p.x)));
  const y = Math.max(0, Math.min(field.height - 1, Math.round(p.y)));
  const i = y * field.width + x;
  return { r: field.R[i], g: field.G[i], b: field.B8[i] };
}

function rgbDistance100(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) / Math.sqrt(3 * 255 * 255) * 100;
}

export function detectRegion(
  field: LabField,
  seed: Pt,
  opts: DetectOptions,
  roi?: { x: number; y: number; w: number; h: number },
): SegmentResult | null {
  const { width: w, height: h } = field;
  const x0 = Math.max(0, roi ? Math.floor(roi.x) : 0);
  const y0 = Math.max(0, roi ? Math.floor(roi.y) : 0);
  const x1 = Math.min(w - 1, roi ? Math.floor(roi.x + roi.w) : w - 1);
  const y1 = Math.min(h - 1, roi ? Math.floor(roi.y + roi.h) : h - 1);

  const sx = Math.round(seed.x);
  const sy = Math.round(seed.y);
  if (sx < x0 || sy < y0 || sx > x1 || sy > y1) return null;

  const seedLab = sampleSeed(field, { x: sx, y: sy }, opts.seedRadius, {
    tolerance: opts.tolerance,
    metric: opts.metric,
  });

  let mask = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  const visited = new Uint8Array(w * h);
  let sumL = 0, sumA = 0, sumB = 0, count = 0;

  while (stack.length) {
    const i = stack.pop()!;
    if (visited[i]) continue;
    visited[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0 || y < y0 || x > x1 || y > y1) continue;
    const lim = opts.channelLimits;
    if (lim) {
      if (lim.L && (field.L[i] < lim.L[0] || field.L[i] > lim.L[1])) continue;
      if (lim.a && (field.A[i] < lim.a[0] || field.A[i] > lim.a[1])) continue;
      if (lim.b && (field.B[i] < lim.b[0] || field.B[i] > lim.b[1])) continue;
      if (lim.R && (field.R[i] < lim.R[0] || field.R[i] > lim.R[1])) continue;
      if (lim.G && (field.G[i] < lim.G[0] || field.G[i] > lim.G[1])) continue;
      if (lim.B && (field.B8[i] < lim.B[0] || field.B8[i] > lim.B[1])) continue;
    }
    const labD = labDistanceW(
      { L: field.L[i], a: field.A[i], b: field.B[i] },
      seedLab,
      opts.metric,
      opts.lightnessWeight ?? 1,
    );
    const seedRgb = rgbFromSeed(field, seed);
    const rgbD = rgbDistance100({ r: field.R[i], g: field.G[i], b: field.B8[i] }, seedRgb);
    const rw = Math.max(0, Math.min(1, opts.rgbWeight ?? 0));
    const d = (1 - rw) * labD + rw * rgbD;
    if (d > opts.tolerance || (rw > 0 && rgbD > (opts.rgbTolerance ?? 18))) continue;
    mask[i] = 1;
    sumL += field.L[i];
    sumA += field.A[i];
    sumB += field.B[i];
    count++;
    if (x > x0) stack.push(i - 1);
    if (x < x1) stack.push(i + 1);
    if (y > y0) stack.push(i - w);
    if (y < y1) stack.push(i + w);
    if (opts.connectivity === 8) {
      if (x > x0 && y > y0) stack.push(i - w - 1);
      if (x < x1 && y > y0) stack.push(i - w + 1);
      if (x > x0 && y < y1) stack.push(i + w - 1);
      if (x < x1 && y < y1) stack.push(i + w + 1);
    }
  }
  if (!count) return null;

  for (let k = 0; k < opts.smooth; k++) mask = dilate(mask, w, h);
  for (let k = 0; k < opts.smooth; k++) mask = erode(mask, w, h);
  if (opts.fillHoles) mask = fillHoles(mask, w, h);

  let area = 0, cxs = 0, cys = 0, sumLFinal = 0, sumAFinal = 0, sumBFinal = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      area++;
      cxs += x;
      cys += y;
      sumLFinal += field.L[i];
      sumAFinal += field.A[i];
      sumBFinal += field.B[i];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

  if (!area) return null;

  const contour = traceContour(mask, w, h);
  const perimeter = polygonPerimeter(contour);
  const { feretMax, feretMin } = feret(contour.length ? contour : [{ x: 0, y: 0 }]);

  return {
    mask,
    width: w,
    height: h,
    contour,
    areaPx: area,
    perimeterPx: perimeter,
    centroid: { x: cxs / area, y: cys / area },
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    circularity: perimeter > 0 ? Math.min(1, (4 * Math.PI * area) / (perimeter * perimeter)) : 0,
    feretMax,
    feretMin,
    meanLab: { L: sumLFinal / area, a: sumAFinal / area, b: sumBFinal / area },
    seedLab,
  };
}

/**
 * Auto-relocate a seed on a new frame: search the neighbourhood of the
 * reference seed for the pixel whose LAB is closest to the reference colour.
 */
export function relocateSeed(
  field: LabField,
  reference: LAB,
  around: Pt,
  searchRadius: number,
  metric: "cie76" | "ciede2000",
  lightnessWeight = 1,
  referenceRgb?: { r: number; g: number; b: number },
  rgbWeight = 0,
): { seed: Pt; delta: number } {
  let best = { seed: around, delta: Infinity };
  const step = searchRadius > 40 ? 2 : 1;
  for (let y = around.y - searchRadius; y <= around.y + searchRadius; y += step) {
    for (let x = around.x - searchRadius; x <= around.x + searchRadius; x += step) {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= field.width || yi >= field.height) continue;
      const i = yi * field.width + xi;
      // Penalise edge pixels: a good seed matches the reference colour AND
      // sits in a flat neighbourhood of the same phase.
      const labD = labDistanceW({ L: field.L[i], a: field.A[i], b: field.B[i] }, reference, metric, lightnessWeight);
      const rgbD = referenceRgb ? Math.hypot(field.R[i] - referenceRgb.r, field.G[i] - referenceRgb.g, field.B8[i] - referenceRgb.b) / Math.sqrt(3 * 255 * 255) * 100 : 0;
      const rw = Math.max(0, Math.min(1, rgbWeight));
      const d = (1 - rw) * labD + rw * rgbD + 0.5 * localSpread(field, xi, yi, 2, metric);
      if (d < best.delta) best = { seed: { x: xi, y: yi }, delta: d };

    }
  }
  return best;
}

/**
 * Reference-anchored relocation with an optional temporal prior. Both candidates
 * are scored against the immutable reference colour; the prior never supplies a
 * mask or hard constraint, so a bad previous frame cannot lock the next frame.
 */
export function relocateSeedWithSoftPrior(
  field: LabField,
  reference: LAB,
  referencePoint: Pt,
  priorPoint: Pt | undefined,
  searchRadius: number,
  metric: "cie76" | "ciede2000",
  lightnessWeight = 1,
  referenceRgb?: { r: number; g: number; b: number },
  rgbWeight = 0,
) {
  const ref = relocateSeed(field, reference, referencePoint, searchRadius, metric, lightnessWeight, referenceRgb, rgbWeight);
  if (!priorPoint) return ref;
  const prior = relocateSeed(field, reference, priorPoint, searchRadius, metric, lightnessWeight, referenceRgb, rgbWeight);
  return prior.delta + 0.75 < ref.delta ? prior : ref;
}

/** 256-bin histogram of the weighted-gray channel for the whole frame or ROI. */
export function histogram(data: ImageData, roi?: { x: number; y: number; w: number; h: number }) {
  const bins = new Uint32Array(256);
  const x0 = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const y0 = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const x1 = roi ? Math.min(data.width, Math.floor(roi.x + roi.w)) : data.width;
  const y1 = roi ? Math.min(data.height, Math.floor(roi.y + roi.h)) : data.height;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = (y * data.width + x) * 4;
      const v = Math.round(
        0.299 * data.data[p] + 0.587 * data.data[p + 1] + 0.114 * data.data[p + 2],
      );
      bins[Math.max(0, Math.min(255, v))]++;
    }
  return bins;
}


/** 256-bin histogram of one channel (gray from RGB, L, a and b from the CIELAB field) for a frame or ROI. */
export function channelHistogram(
  data: ImageData,
  field: LabField,
  channel: ChannelId,
  roi?: { x: number; y: number; w: number; h: number },
) {
  if (channel === "gray") return histogram(data, roi);
  const { min, max } = CHANNELS[channel];
  const arr = channel === "L" ? field.L : channel === "a" ? field.A : channel === "b" ? field.B : channel === "R" ? field.R : channel === "G" ? field.G : field.B8;
  const bins = new Uint32Array(256);
  const x0 = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const y0 = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const x1 = roi ? Math.min(field.width, Math.floor(roi.x + roi.w)) : field.width;
  const y1 = roi ? Math.min(field.height, Math.floor(roi.y + roi.h)) : field.height;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const k = Math.floor(((arr[y * field.width + x] - min) / (max - min)) * 255);
      bins[Math.max(0, Math.min(255, k))]++;
    }
  return bins;
}

function percentile(sorted: Float32Array, q: number) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))))];
}

/**
 * Robust L, a and b windows covering a traced region (2nd–98th percentile, lightly padded).
 * Used to turn a selected region into histogram limits that also apply in other frames.
 */
export function regionLimits(field: LabField, mask: Uint8Array): ChannelLimits | null {
  const L: number[] = [], A: number[] = [], B: number[] = [], R: number[] = [], G: number[] = [], RB: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) { L.push(field.L[i]); A.push(field.A[i]); B.push(field.B[i]); R.push(field.R[i]); G.push(field.G[i]); RB.push(field.B8[i]); }
  if (L.length < 8) return null;
  const win = (v: number[], pad: number): [number, number] => {
    const s = Float32Array.from(v).sort();
    return [percentile(s, 0.02) - pad, percentile(s, 0.98) + pad];
  };
  return { L: win(L, 2), a: win(A, 1.5), b: win(B, 1.5), R: win(R, 4), G: win(G, 4), B: win(RB, 4) };
}

/** Median CIELAB of the outer frame ring — a stand-in for the background/illumination level. */
export function borderStats(field: LabField, ringFraction = 0.05): LAB {
  const rx = Math.max(1, Math.round(field.width * ringFraction));
  const ry = Math.max(1, Math.round(field.height * ringFraction));
  const L: number[] = [], A: number[] = [], B: number[] = [];
  for (let y = 0; y < field.height; y++) for (let x = 0; x < field.width; x++) {
    if (x >= rx && x < field.width - rx && y >= ry && y < field.height - ry) { x = field.width - rx - 1; continue; }
    const i = y * field.width + x;
    L.push(field.L[i]); A.push(field.A[i]); B.push(field.B[i]);
  }
  const med = (v: number[]) => percentile(Float32Array.from(v).sort(), 0.5);
  return { L: med(L), a: med(A), b: med(B) };
}

/** Shift a frame's CIELAB field so its border colour matches the reference frame's. */
export function normalizeToReference(field: LabField, reference: LAB): LabField {
  const own = borderStats(field);
  const dL = reference.L - own.L, dA = reference.a - own.a, dB = reference.b - own.b;
  const L = new Float32Array(field.L.length), A = new Float32Array(field.A.length), B = new Float32Array(field.B.length);
  for (let i = 0; i < L.length; i++) { L[i] = field.L[i] + dL; A[i] = field.A[i] + dA; B[i] = field.B[i] + dB; }
  return { L, A, B, R: field.R, G: field.G, B8: field.B8, width: field.width, height: field.height };
}
