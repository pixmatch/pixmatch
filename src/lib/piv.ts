/**
 * Lightweight, reference-free PIV-style image velocimetry for PixMatch.
 *
 * This is an image cross-correlation tracker, not a CFD solver. It is intended
 * for experimental image sequences where tracer texture/particles move between
 * consecutive frames. The implementation supports bulk consecutive-frame pairs,
 * configurable FPS, physical calibration, quality metrics, vector validation,
 * and an optional two-pass refinement.
 */

import type { Pt } from "./segmentation";
import type { Scale } from "./pixmatch";

export type PivConfig = {
  windowSize: number;
  step: number;
  searchRadius: number;
  sampleStride: 2 | 1;
  minCorrelation: number;
  minSNR: number;
  vectorMedianTolerance: number;
  frameStride: number;
  fps: number;
  twoPass: boolean;
  pass1WindowScale: 2 | 1;
  roi?: { x: number; y: number; w: number; h: number } | null;
};

export type PivVector = {
  x: number;
  y: number;
  u: number;
  v: number;
  speedPxPerFrame: number;
  correlation: number;
  snr: number;
  valid: boolean;
};

export type PivPairResult = {
  frameA: number;
  frameB: number;
  dtFrames: number;
  dtSeconds: number;
  vectors: PivVector[];
  validCount: number;
  totalCount: number;
  meanCorrelation: number;
  meanU: number;
  meanV: number;
  scale?: Scale;
};

export const DEFAULT_PIV: PivConfig = {
  windowSize: 32,
  step: 32,
  searchRadius: 6,
  sampleStride: 2,
  minCorrelation: 0.35,
  minSNR: 1.0,
  vectorMedianTolerance: 2.5,
  frameStride: 1,
  fps: 30,
  twoPass: true,
  pass1WindowScale: 2,
  roi: null,
};

function grayField(data: ImageData) {
  const out = new Float32Array(data.width * data.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = 0.299 * data.data[o] + 0.587 * data.data[o + 1] + 0.114 * data.data[o + 2];
  }
  return out;
}

function ncc(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  cxA: number,
  cyA: number,
  cxB: number,
  cyB: number,
  half: number,
  sampleStride: number,
) {
  let sa = 0, sb = 0, n = 0;
  for (let y = -half; y <= half; y += sampleStride) {
    for (let x = -half; x <= half; x += sampleStride) {
      const ax = cxA + x, ay = cyA + y, bx = cxB + x, by = cyB + y;
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= w || ay >= h || bx >= w || by >= h) continue;
      sa += a[ay * w + ax]; sb += b[by * w + bx]; n++;
    }
  }
  if (n < 16) return -1;
  const ma = sa / n, mb = sb / n;
  let va = 0, vb = 0, cov = 0;
  for (let y = -half; y <= half; y += sampleStride) {
    for (let x = -half; x <= half; x += sampleStride) {
      const ax = cxA + x, ay = cyA + y, bx = cxB + x, by = cyB + y;
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= w || ay >= h || bx >= w || by >= h) continue;
      const da = a[ay * w + ax] - ma, db = b[by * w + bx] - mb;
      va += da * da; vb += db * db; cov += da * db;
    }
  }
  const den = Math.sqrt(va * vb);
  return den > 1e-6 ? cov / den : -1;
}

function bestMatch(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  searchRadius: number,
  half: number,
  sampleStride: number,
  predicted?: Pt,
) {
  const px = predicted?.x ?? 0, py = predicted?.y ?? 0;
  let best = { dx: Math.round(px), dy: Math.round(py), c: -1 };
  const candidates: number[] = [];
  for (let dy = -searchRadius; dy <= searchRadius; dy++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const ddx = Math.round(px) + dx, ddy = Math.round(py) + dy;
      const c = ncc(a, b, w, h, x, y, x + ddx, y + ddy, half, sampleStride);
      candidates.push(c);
      if (c > best.c) best = { dx: ddx, dy: ddy, c };
    }
  }
  candidates.sort((m, n) => n - m);
  const second = candidates.find((c) => c < best.c - 1e-5) ?? best.c;
  const snr = best.c > 0 && second > 0 ? best.c / Math.max(1e-6, second) : best.c > 0 ? 2 : 0;
  return { ...best, snr };
}

function gridPositions(width: number, height: number, cfg: PivConfig) {
  const roi = cfg.roi ?? { x: 0, y: 0, w: width, h: height };
  const out: Pt[] = [];
  const half = Math.floor(cfg.windowSize / 2);
  const x0 = Math.ceil(roi.x + half), x1 = Math.floor(roi.x + roi.w - half - 1);
  const y0 = Math.ceil(roi.y + half), y1 = Math.floor(roi.y + roi.h - half - 1);
  for (let y = y0; y <= y1; y += cfg.step) for (let x = x0; x <= x1; x += cfg.step) out.push({ x, y });
  return out;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function validateVectors(vectors: PivVector[], tolerance: number) {
  const valid = vectors.filter((v) => v.correlation > 0 && Number.isFinite(v.u) && Number.isFinite(v.v));
  if (valid.length < 5) return vectors;
  const medU = median(valid.map((v) => v.u));
  const medV = median(valid.map((v) => v.v));
  return vectors.map((v) => {
    if (!v.valid) return v;
    const residual = Math.hypot(v.u - medU, v.v - medV);
    return residual <= tolerance ? v : { ...v, valid: false };
  });
}

function pass(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  cfg: PivConfig,
  predicted: Map<string, Pt> = new Map(),
) {
  const half = Math.max(3, Math.floor(cfg.windowSize / 2));
  const positions = gridPositions(width, height, cfg);
  const vectors: PivVector[] = [];
  for (const p of positions) {
    const key = `${p.x},${p.y}`;
    const m = bestMatch(a, b, width, height, p.x, p.y, cfg.searchRadius, half, cfg.sampleStride, predicted.get(key));
    const valid = m.c >= cfg.minCorrelation && m.snr >= cfg.minSNR;
    vectors.push({
      x: p.x, y: p.y, u: m.dx, v: m.dy,
      speedPxPerFrame: Math.hypot(m.dx, m.dy),
      correlation: m.c, snr: m.snr, valid,
    });
  }
  return validateVectors(vectors, cfg.vectorMedianTolerance);
}

export function computePivPair(
  frameA: ImageData,
  frameB: ImageData,
  config: PivConfig = DEFAULT_PIV,
  frameAIndex = 0,
  frameBIndex = 1,
  scale?: Scale,
): PivPairResult {
  if (frameA.width !== frameB.width || frameA.height !== frameB.height) {
    throw new Error("PIV requires paired images with the same pixel dimensions. Resize/crop the sequence first.");
  }
  const a = grayField(frameA), b = grayField(frameB);
  let vectors: PivVector[];
  if (config.twoPass) {
    const coarseCfg = { ...config, windowSize: config.windowSize * config.pass1WindowScale, step: config.step * config.pass1WindowScale, searchRadius: config.searchRadius * 2, twoPass: false };
    const coarse = pass(a, b, frameA.width, frameA.height, coarseCfg);
    const predicted = new Map<string, Pt>();
    const finePositions = gridPositions(frameA.width, frameA.height, config);
    for (const fp of finePositions) {
      let best: PivVector | null = null, bestD = Infinity;
      for (const cp of coarse) {
        const d = (cp.x - fp.x) ** 2 + (cp.y - fp.y) ** 2;
        if (d < bestD) { bestD = d; best = cp; }
      }
      if (best?.valid) predicted.set(`${fp.x},${fp.y}`, { x: best.u, y: best.v });
    }
    vectors = pass(a, b, frameA.width, frameA.height, { ...config, twoPass: false }, predicted);
  } else {
    vectors = pass(a, b, frameA.width, frameA.height, config);
  }
  const valid = vectors.filter((v) => v.valid);
  const dtFrames = Math.max(1, frameBIndex - frameAIndex);
  const dtSeconds = dtFrames / Math.max(1e-9, config.fps);
  return {
    frameA: frameAIndex, frameB: frameBIndex, dtFrames, dtSeconds,
    vectors, totalCount: vectors.length, validCount: valid.length,
    meanCorrelation: valid.length ? valid.reduce((s, v) => s + v.correlation, 0) / valid.length : 0,
    meanU: valid.length ? valid.reduce((s, v) => s + v.u, 0) / valid.length : 0,
    meanV: valid.length ? valid.reduce((s, v) => s + v.v, 0) / valid.length : 0,
    scale,
  };
}

export function vectorPhysical(v: PivVector, result: PivPairResult) {
  const pxPerUnit = result.scale?.pxPerUnit ?? 0;
  if (!pxPerUnit) return { dx: v.u, dy: v.v, speed: v.speedPxPerFrame / Math.max(1e-9, result.dtSeconds), unit: "px/s" };
  const dx = v.u / pxPerUnit, dy = v.v / pxPerUnit;
  return { dx, dy, speed: Math.hypot(dx, dy) / Math.max(1e-9, result.dtSeconds), unit: `${result.scale?.unit ?? "unit"}/s` };
}

export function exportPivCsv(results: PivPairResult[]) {
  const head = "FrameA,FrameB,dt_frames,dt_seconds,x_px,y_px,u_px_per_frame,v_px_per_frame,speed_px_per_frame,correlation,SNR,valid,u_physical_per_s,v_physical_per_s,speed_physical_per_s,physical_unit";
  const rows = results.flatMap((r) => r.vectors.map((v) => {
    const p = vectorPhysical(v, r);
    return [r.frameA + 1, r.frameB + 1, r.dtFrames, r.dtSeconds, v.x, v.y, v.u, v.v, v.speedPxPerFrame, v.correlation, v.snr, v.valid, p.dx, p.dy, p.speed, p.unit]
      .map((x) => `"${String(x)}"`).join(",");
  }));
  return [head, ...rows].join("\n");
}
