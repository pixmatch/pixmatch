import type { PhaseMask } from '../types';

type Roi = { x: number; y: number; width: number; height: number };

/**
 * Square-element erosion / dilation, computed as two 1-D passes (rows then columns).
 * A square structuring element is separable, so this equals the 2-D result at O(r) instead of O(r²) per pixel.
 * Pixels beyond the image edge are ignored (neutral). Pixels outside `roi` are copied unchanged.
 */
function morph(src: PhaseMask, r: number, dilate: boolean, roi?: Roi): PhaseMask {
  const { width: w, height: h, data } = src;
  if (r <= 0) return { width: w, height: h, data: new Uint8Array(data) };
  const tmp = new Uint8Array(data.length);
  const out = new Uint8Array(data.length);
  // horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let hit = dilate ? 0 : 1;
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let xx = a; xx <= b; xx++) {
        const v = data[row + xx];
        if (dilate) { if (v) { hit = 1; break; } } else if (!v) { hit = 0; break; }
      }
      tmp[row + x] = hit;
    }
  }
  // vertical pass
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let hit = dilate ? 0 : 1;
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let yy = a; yy <= b; yy++) {
        const v = tmp[yy * w + x];
        if (dilate) { if (v) { hit = 1; break; } } else if (!v) { hit = 0; break; }
      }
      out[y * w + x] = hit;
    }
  }
  if (roi) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < roi.x || y < roi.y || x >= roi.x + roi.width || y >= roi.y + roi.height) out[y * w + x] = data[y * w + x];
    }
  }
  return { width: w, height: h, data: out };
}
export const dilate = (m: PhaseMask, r: number, roi?: Roi) => morph(m, r, true, roi);
export const erode = (m: PhaseMask, r: number, roi?: Roi) => morph(m, r, false, roi);
/** Erode then dilate: removes specks smaller than the element. */
export function opening(m: PhaseMask, r: number, roi?: Roi) { return dilate(erode(m, r, roi), r, roi); }
/** Dilate then erode: closes gaps smaller than the element. */
export function closing(m: PhaseMask, r: number, roi?: Roi) { return erode(dilate(m, r, roi), r, roi); }

/** Fill background regions that are not connected (4-neighbourhood) to the image border. */
export function fillHoles(mask: PhaseMask): PhaseMask {
  const { width: w, height: h, data } = mask;
  const seen = new Uint8Array(data.length);
  const q = new Int32Array(data.length);
  let tail = 0;
  const push = (i: number) => { if (!seen[i] && !data[i]) { seen[i] = 1; q[tail++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  for (let head = 0; head < tail; head++) {
    const i = q[head], x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const out = new Uint8Array(data);
  for (let i = 0; i < out.length; i++) if (!out[i] && !seen[i]) out[i] = 1;
  return { width: w, height: h, data: out };
}
