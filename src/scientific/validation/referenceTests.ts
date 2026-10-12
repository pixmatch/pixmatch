import { rgbToLab } from '../color/rgbToLab';
import { deltaE00 } from '../color/ciede2000';
import { processBatch } from '../execution/processBatch';
import type { BatchRecipe, ImageFrame, Lab, RGB } from '../types';

export interface SelfCheckItem { name: string; ok: boolean; detail: string; }

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Builds a w×h RGBA frame filled with `bg`, with a solid `fg` rectangle spanning rows y0..y1 (inclusive), columns x0..x1. */
export function syntheticFrame(w: number, h: number, bg: RGB, fg: RGB, rect: { x0: number; x1: number; y0: number; y1: number } | null, index = 0): ImageFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = !!rect && x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
    const c = inside ? fg : bg, p = (y * w + x) * 4;
    data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255;
  }
  return { frameIndex: index, width: w, height: h, data, name: `synthetic-${index}.png` };
}

/** Known-answer checks of the whole pipeline. Pure and fast; safe to run in the browser or in Node. */
export function runScientificSelfCheck(): { ok: boolean; items: SelfCheckItem[]; checks: string[] } {
  const items: SelfCheckItem[] = [];
  const add = (name: string, ok: boolean, detail: string) => items.push({ name, ok, detail });

  const white = rgbToLab([255, 255, 255]), black = rgbToLab([0, 0, 0]), red = rgbToLab([255, 0, 0]);
  add('sRGB white → Lab (100, 0, 0)', near(white[0], 100, 0.01) && near(white[1], 0, 0.01) && near(white[2], 0, 0.01), white.map(v => v.toFixed(3)).join(', '));
  add('sRGB black → Lab (0, 0, 0)', near(black[0], 0, 0.01) && near(black[1], 0, 0.01) && near(black[2], 0, 0.01), black.map(v => v.toFixed(3)).join(', '));
  add('sRGB red → Lab ≈ (53.24, 80.09, 67.20)', near(red[0], 53.24, 0.05) && near(red[1], 80.09, 0.05) && near(red[2], 67.2, 0.05), red.map(v => v.toFixed(2)).join(', '));

  // Sharma, Wu & Dalal (2005) CIEDE2000 test data
  const sharma: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  ];
  sharma.forEach(([a, b, expected], i) => {
    const got = deltaE00(a, b);
    add(`CIEDE2000 reference pair ${i + 1}`, near(got, expected, 1e-3), `got ${got.toFixed(4)}, expected ${expected}`);
  });

  const recipe = (over: Partial<BatchRecipe['measurements'][0]['segmentation']> = {}, convention: 'PIXEL_CENTER' | 'INCLUSIVE_PIXEL' = 'PIXEL_CENTER', baselineY?: number): BatchRecipe => ({
    algorithmVersion: 'self-check', allowInterpolation: false, calibration: { mmPerPixel: 0.1 },
    measurements: [{
      id: 'h', name: 'Height', phase: 'TARGET_PHASE', quantity: 'HEIGHT', measurementConvention: convention, baselineY,
      segmentation: { colorSpace: 'CIELAB', targetPhase: 'TARGET_PHASE', referenceLab: rgbToLab([200, 30, 30]), deltaEThreshold: 8, ...over },
    }],
  });
  const bg: RGB = [240, 240, 240], fg: RGB = [200, 30, 30];

  const f1 = syntheticFrame(40, 40, bg, fg, { x0: 10, x1: 29, y0: 10, y1: 29 }, 0); // 20 rows → 19 (centre) / 20 (inclusive)
  const r1 = processBatch('t', [f1], recipe()).results[0];
  add('height from bounds (PIXEL_CENTER)', r1.pixelHeight === 19 && r1.minY === 10 && r1.maxY === 29, `minY ${r1.minY}, maxY ${r1.maxY}, height ${r1.pixelHeight}px`);
  add('calibration → mm', near(r1.physicalHeightMm ?? NaN, 1.9, 1e-9), `${r1.physicalHeightMm} mm`);
  const r2 = processBatch('t', [f1], recipe({}, 'INCLUSIVE_PIXEL')).results[0];
  add('height (INCLUSIVE_PIXEL) counts both edge pixels', r2.pixelHeight === 20, `${r2.pixelHeight}px`);
  const r3 = processBatch('t', [f1], recipe({}, 'PIXEL_CENTER', 35)).results[0];
  add('baseline row replaces the bottom edge', r3.pixelHeight === 25, `${r3.pixelHeight}px (baseline 35 − top 10)`);
  add('confidence is measured, status VALID', r1.status === 'VALID' && r1.confidence > 0.6 && !!r1.confidenceParts && r1.componentCount === 1, `confidence ${r1.confidence.toFixed(3)}, status ${r1.status}`);

  const empty = syntheticFrame(40, 40, bg, fg, null, 1);
  const r4 = processBatch('t', [empty], recipe()).results[0];
  add('no phase → MISSING_PHASE, nothing invented', r4.status === 'MISSING_PHASE' && r4.physicalHeightMm === null && r4.confidence === 0, `${r4.status}`);
  const broken: ImageFrame = { frameIndex: 2, width: 10, height: 10, data: new Uint8ClampedArray(8) };
  const r5 = processBatch('t', [broken], recipe()).results[0];
  add('inconsistent buffer → INVALID_FRAME', r5.status === 'INVALID_FRAME', r5.status);

  const speck = syntheticFrame(40, 40, bg, fg, { x0: 10, x1: 29, y0: 10, y1: 29 }, 3);
  const q = (3 * 40 + 3) * 4; speck.data[q] = fg[0]; speck.data[q + 1] = fg[1]; speck.data[q + 2] = fg[2]; // one stray pixel at row 3
  const r6 = processBatch('t', [speck], recipe()).results[0];
  const r7 = processBatch('t', [speck], recipe({ connectedComponents: { enabled: true, minimumAreaPixels: 5, keepLargestOnly: true } })).results[0];
  add('stray pixel moves the edge unless filtered', r6.minY === 3 && r7.minY === 10, `unfiltered minY ${r6.minY}, filtered minY ${r7.minY}`);

  let threw = '';
  try { processBatch('t', [f1], { ...recipe(), calibration: { mmPerPixel: 0 } }); } catch (e) { threw = String((e as Error).message); }
  add('invalid calibration is rejected before processing', threw === 'INVALID_CALIBRATION', threw || 'did not throw');

  const ok = items.every(i => i.ok);
  return { ok, items, checks: items.map(i => i.name) };
}
