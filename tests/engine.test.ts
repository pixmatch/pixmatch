import assert from 'node:assert/strict';
import { runScientificSelfCheck, syntheticFrame } from '../src/scientific/validation/referenceTests';
import { processBatch, BatchSession } from '../src/scientific/execution/processBatch';
import { deltaE00, deltaE00Bounded } from '../src/scientific/color/ciede2000';
import { imageToLab, rgbToLab } from '../src/scientific/color/rgbToLab';
import { extractVerticalBounds } from '../src/scientific/geometry/bounds';
import { erode, dilate, opening, closing, fillHoles } from '../src/scientific/segmentation/morphology';
import { filterComponents, connectedComponents } from '../src/scientific/segmentation/connectedComponents';
import { exportCSV, exportAuditJSON } from '../src/scientific/export/export';
import { validateAudit } from '../src/scientific/audit/audit';
import { extractBoundary, boundaryConnectivity } from '../src/scientific/geometry/boundary';
import { boundsFromBoundary } from '../src/scientific/geometry/bounds';
import { labToRgb } from '../src/scientific/color/rgbToLab';
import { buildHeightRecipe, ENGINE_VERSION } from '../src/scientific/execution/recipeBuilder';
import { mmPerPixelFromScale } from '../src/scientific/calibration/calibration';
import type { BatchRecipe, Lab, RGB } from '../src/scientific/types';

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n      ', (e as Error).message); } };

// 1. built-in self check
const sc = runScientificSelfCheck();
for (const i of sc.items) t('self-check: ' + i.name, () => assert.ok(i.ok, i.detail));

// 2. bounded ΔE agrees with exact ΔE below the cutoff, and is a valid lower bound above it
t('deltaE00Bounded == exact when ≤ cutoff, lower bound otherwise (20k random pairs)', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 20000; i++) {
    const a: Lab = [rnd() * 100, rnd() * 200 - 100, rnd() * 200 - 100], b: Lab = [rnd() * 100, rnd() * 200 - 100, rnd() * 200 - 100];
    const cutoff = 1 + rnd() * 20, exact = deltaE00(a, b), bounded = deltaE00Bounded(a, b, cutoff);
    if (exact <= cutoff) assert.ok(Math.abs(exact - bounded) < 1e-12, 'exact mismatch');
    else { assert.ok(bounded > cutoff, 'bound must exceed cutoff'); assert.ok(bounded <= exact + 1e-9, 'bound must be ≤ exact'); }
  }
});

// 3. fast imageToLab matches rgbToLab
t('imageToLab == per-pixel rgbToLab', () => {
  const f = syntheticFrame(4, 4, [10, 200, 90], [250, 5, 77], { x0: 1, x1: 2, y0: 1, y1: 2 });
  const lab = imageToLab(f);
  for (let i = 0; i < 16; i++) {
    const ref = rgbToLab([f.data[i * 4], f.data[i * 4 + 1], f.data[i * 4 + 2]] as RGB);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(lab[i * 3 + k] - ref[k]) < 1e-3);
  }
});

// 4. morphology & components
const maskOf = (w: number, h: number, pts: [number, number][]) => { const d = new Uint8Array(w * h); pts.forEach(([x, y]) => (d[y * w + x] = 1)); return { width: w, height: h, data: d }; };
t('erode shrinks a 5×5 block to 3×3; dilate grows back', () => {
  const pts: [number, number][] = []; for (let y = 3; y < 8; y++) for (let x = 3; x < 8; x++) pts.push([x, y]);
  const m = maskOf(12, 12, pts);
  assert.equal(erode(m, 1).data.reduce((a, b) => a + b, 0), 9);
  assert.equal(dilate(erode(m, 1), 1).data.reduce((a, b) => a + b, 0), 25);
  assert.equal(opening(m, 1).data.reduce((a, b) => a + b, 0), 25);
});
t('opening removes a lone pixel; closing fills a 1-px gap', () => {
  const a = maskOf(9, 9, [[4, 4]]); assert.equal(opening(a, 1).data.reduce((x, y) => x + y, 0), 0);
  const pts: [number, number][] = []; for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) if (!(x === 4 && y === 4)) pts.push([x, y]);
  assert.equal(closing(maskOf(9, 9, pts), 1).data.reduce((x, y) => x + y, 0), 25);
});
t('fillHoles fills an enclosed hole but not an open notch', () => {
  const pts: [number, number][] = []; for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) if (!(x === 4 && y === 4)) pts.push([x, y]);
  assert.equal(fillHoles(maskOf(9, 9, pts)).data[4 * 9 + 4], 1);
  const notch: [number, number][] = []; for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) if (!(x === 4 && y <= 3)) notch.push([x, y]);
  assert.equal(fillHoles(maskOf(9, 9, notch)).data[2 * 9 + 4], 0);
});
t('component labelling, area filter, keepLargestOnly', () => {
  const pts: [number, number][] = [[0, 0], [10, 10], [10, 11], [11, 10], [11, 11]]; for (let x = 3; x < 8; x++) for (let y = 3; y < 6; y++) pts.push([x, y]);
  const m = maskOf(14, 14, pts);
  assert.equal(connectedComponents(m).length, 3);
  assert.equal(filterComponents(m, 2).data.reduce((a, b) => a + b, 0), 19);
  assert.equal(filterComponents(m, 1, undefined, true).data.reduce((a, b) => a + b, 0), 15);
});
t('percentile bounds ignore a speck, plain bounds do not', () => {
  const pts: [number, number][] = [[1, 0]]; for (let y = 10; y < 30; y++) for (let x = 5; x < 15; x++) pts.push([x, y]);
  const m = maskOf(20, 40, pts);
  assert.equal(extractVerticalBounds(m, 'PIXEL_CENTER')!.minY, 0);
  assert.equal(extractVerticalBounds(m, 'PIXEL_CENTER', { enabled: true, low: 1, high: 100 })!.minY, 10);
});

// 5. end-to-end behaviours
const base = (over: Partial<BatchRecipe> = {}): BatchRecipe => ({
  algorithmVersion: 'test', allowInterpolation: false, calibration: { mmPerPixel: 0.05, uncertaintyMmPerPixel: 0.001 },
  measurements: [{ id: 'h', name: 'Height', phase: 'TARGET_PHASE', quantity: 'HEIGHT', measurementConvention: 'INCLUSIVE_PIXEL',
    segmentation: { colorSpace: 'CIELAB', targetPhase: 'TARGET_PHASE', referenceLab: rgbToLab([200, 30, 30]), deltaEThreshold: 8,
      connectedComponents: { enabled: true, minimumAreaPixels: 20, keepLargestOnly: true } } }], ...over });
const fg: RGB = [200, 30, 30], bg: RGB = [240, 240, 240];
// shrinking droplet: heights 40,36,32,28,24 px
const seq = [40, 36, 32, 28, 24].map((h, i) => syntheticFrame(80, 100, bg, fg, { x0: 20, x1: 59, y0: 10, y1: 10 + h - 1 }, i));
t('shrinking sequence is tracked frame by frame (each frame independent)', () => {
  const r = processBatch('seq', seq, base());
  assert.deepEqual(r.results.map(x => x.pixelHeight), [40, 36, 32, 28, 24]);
  r.results.forEach(x => assert.ok(Math.abs(x.physicalHeightMm! - x.pixelHeight! * 0.05) < 1e-12));
  assert.ok(validateAudit(r));
  assert.equal(r.audit.frameCount, 5);
  assert.equal(r.audit.statusCounts!['VALID'], 5);
  assert.ok(r.results[0].uncertainty!.combinedUncertaintyMm > 0);
});
t('confidence parts are measured (clean phase scores high; ragged/dusty phase scores lower)', () => {
  const clean = processBatch('c', [seq[0]], base()).results[0];
  const dusty = syntheticFrame(80, 100, bg, fg, { x0: 20, x1: 59, y0: 10, y1: 49 }, 9);
  let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 400; i++) { const x = Math.floor(rnd() * 80), y = Math.floor(rnd() * 100); const p = (y * 80 + x) * 4; dusty.data[p] = fg[0]; dusty.data[p + 1] = fg[1]; dusty.data[p + 2] = fg[2]; }
  const rec = base(); rec.measurements[0].segmentation.connectedComponents = undefined;
  const dirty = processBatch('d', [dusty], rec).results[0];
  assert.ok(clean.confidence > dirty.confidence, `${clean.confidence} vs ${dirty.confidence}`);
  assert.ok(dirty.componentCount! > 50, 'component count must be measured, not hard-coded');
  assert.ok(Object.values(clean.confidenceParts!).every(v => v >= 0 && v <= 1));
  assert.ok(clean.confidenceParts!.components === 1 && dirty.confidenceParts!.components < 1);
});
t('missing phase is reported, interpolation only when allowed and only between VALID frames', () => {
  const frames = [seq[0], syntheticFrame(80, 100, bg, fg, null, 1), seq[2]].map((f, i) => ({ ...f, frameIndex: i }));
  const off = processBatch('i', frames, base()).results;
  assert.equal(off[1].status, 'MISSING_PHASE'); assert.equal(off[1].physicalHeightMm, null);
  const on = processBatch('i', frames, base({ allowInterpolation: true })).results;
  assert.equal(on[1].status, 'INTERPOLATED'); assert.ok(Math.abs(on[1].physicalHeightMm! - (40 + 32) / 2 * 0.05) < 1e-9); assert.ok(Math.abs(on[1].pixelHeight! - 36) < 1e-9);
  const ends = processBatch('i', [frames[1], frames[2]].map((f, i) => ({ ...f, frameIndex: i })), base({ allowInterpolation: true })).results;
  assert.equal(ends[0].status, 'MISSING_PHASE', 'cannot extrapolate');
});
t('illumination matching recovers a darkened frame', () => {
  const dark = syntheticFrame(80, 100, bg, fg, { x0: 20, x1: 59, y0: 10, y1: 49 }, 0);
  for (let i = 0; i < dark.data.length; i += 4) { dark.data[i] *= 0.8; dark.data[i + 1] *= 0.8; dark.data[i + 2] *= 0.8; }
  const rec = base(); rec.measurements[0].segmentation.deltaEThreshold = 4;
  assert.equal(processBatch('x', [dark], rec).results[0].status, 'MISSING_PHASE', 'darkened frame should miss at tight tolerance');
  const refMedian = (() => { const l = imageToLab(seq[0]); const v: number[] = []; for (let i = 0; i < l.length; i += 3) v.push(l[i]); v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; })();
  rec.measurements[0].segmentation.illumination = { enabled: true, targetMedianL: refMedian };
  const fixed = processBatch('x', [dark], rec).results[0];
  assert.ok(fixed.pixelHeight === 40, `height ${fixed.pixelHeight} status ${fixed.status}`);
});
t('ROI restricts the search; different frame sizes produce a warning', () => {
  const rec = base(); rec.measurements[0].segmentation.roi = { x: 0, y: 0, width: 80, height: 30 };
  const r = processBatch('roi', [seq[0]], rec).results[0];
  assert.equal(r.maxY, 29);
  const small = syntheticFrame(40, 50, bg, fg, { x0: 5, x1: 25, y0: 5, y1: 30 }, 1);
  const out = processBatch('w', [seq[0], small], base());
  assert.ok(out.audit.warnings!.length === 1);
});
t('session streams frames and matches the batch helper', () => {
  const s = new BatchSession('s', base()); seq.forEach(f => s.add(f));
  assert.deepEqual(s.finish().results.map(x => x.pixelHeight), [40, 36, 32, 28, 24]);
});
t('recipe validation rejects bad input before processing', () => {
  assert.throws(() => processBatch('v', seq, base({ calibration: { mmPerPixel: -1 } })), /INVALID_CALIBRATION/);
  const r = base(); r.measurements[0].quantity = 'AREA'; assert.throws(() => processBatch('v', seq, r), /UNSUPPORTED_QUANTITY/);
  const r2 = base(); r2.measurements[0].segmentation.deltaEThreshold = 0; assert.throws(() => processBatch('v', seq, r2), /INVALID_DELTA_E/);
  assert.throws(() => processBatch('v', seq, base({ measurements: [] })), /NO_MEASUREMENTS/);
});
t('exports: CSV has one row per result + header, audit JSON parses', () => {
  const r = processBatch('e', seq, base());
  const lines = exportCSV(r).split('\n'); assert.equal(lines.length, 6); assert.ok(lines[0].startsWith('"frame","frameName"'));
  assert.equal(JSON.parse(exportAuditJSON(r)).frameCount, 5);
});
t('unit conversion to mm/px', () => {
  assert.ok(Math.abs(mmPerPixelFromScale(20, 'mm')! - 0.05) < 1e-12);
  assert.ok(Math.abs(mmPerPixelFromScale(2, 'cm')! - 5) < 1e-12);
  assert.equal(mmPerPixelFromScale(0, 'mm'), null); assert.equal(mmPerPixelFromScale(10, 'px'), null);
});
t('performance: 1600×1200 frame segments in under 3 s', () => {
  const big = syntheticFrame(1600, 1200, bg, fg, { x0: 400, x1: 1200, y0: 200, y1: 900 }, 0);
  const t0 = performance.now(); processBatch('p', [big], base()); const ms = performance.now() - t0; console.log(`        (${ms.toFixed(0)} ms)`);
  assert.ok(ms < 3000, `${ms} ms`);
});
t('boundary extraction: ring pixels only, profiles, connectivity', () => {
  const pts: [number, number][] = []; for (let y = 4; y < 14; y++) for (let x = 5; x < 15; x++) pts.push([x, y]);
  const b = extractBoundary(maskOf(20, 20, pts));
  assert.equal(b.edgePixelCount, 36);             // 10×10 block → 36 border pixels
  assert.equal(b.topProfile[7], 4); assert.equal(b.bottomProfile[7], 13); assert.equal(b.topProfile[2], -1);
  assert.ok(boundaryConnectivity(b) > 0.99);
  assert.deepEqual(boundsFromBoundary(b, 'INCLUSIVE_PIXEL'), { minY: 4, maxY: 13, pixelHeight: 10 });
});
t('labToRgb round-trips rgbToLab', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [200, 30, 30], [12, 140, 220], [128, 128, 128]] as RGB[]) {
    const back = labToRgb(rgbToLab(c)); c.forEach((v, k) => assert.ok(Math.abs(v - back[k]) <= 1, `${c} → ${back}`));
  }
});
t('buildHeightRecipe wires every option into the engine recipe', () => {
  const r = buildHeightRecipe({ referenceLab: [50, 10, 10], deltaE: 7, mmPerPixel: 0.02, openingRadius: 1, fillHoles: true, trimPercent: 0.5, targetMedianL: 80, baselineY: 120, convention: 'PIXEL_CENTER', allowInterpolation: true });
  const m = r.measurements[0], s = m.segmentation;
  assert.equal(r.calibration.mmPerPixel, 0.02); assert.equal(m.baselineY, 120); assert.equal(m.measurementConvention, 'PIXEL_CENTER');
  assert.equal(s.morphology!.openingRadius, 1); assert.equal(s.morphology!.fillHoles, true);
  assert.deepEqual(s.percentileBoundary, { enabled: true, low: 0.5, high: 99.5 }); assert.equal(s.illumination!.targetMedianL, 80);
  assert.equal(r.allowInterpolation, true); assert.equal(r.algorithmVersion, ENGINE_VERSION);
  assert.equal(buildHeightRecipe({ referenceLab: [1, 1, 1], deltaE: 5, mmPerPixel: 1 }).measurements[0].segmentation.morphology, undefined);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
