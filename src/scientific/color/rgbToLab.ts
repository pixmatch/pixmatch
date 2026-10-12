import type { Lab, RGB, XYZ } from '../types';

/** D65 reference white (CIE 1931 2°). */
const D65: XYZ = [0.95047, 1, 1.08883];

/** sRGB gamma decode, pre-computed for the 256 possible 8-bit values. */
const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** sRGB (0–255) → CIE XYZ (D65, Y = 1 for white). Gamma is decoded before the matrix is applied. */
export function rgbToXyz(rgb: RGB): XYZ {
  const r = LINEAR[clamp8(rgb[0])], g = LINEAR[clamp8(rgb[1])], b = LINEAR[clamp8(rgb[2])];
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
  ];
}
const DELTA = 6 / 29;
const f = (t: number) => (t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29);

export function xyzToLab([x, y, z]: XYZ): Lab {
  const fx = f(x / D65[0]), fy = f(y / D65[1]), fz = f(z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function rgbToLab(rgb: RGB): Lab { return xyzToLab(rgbToXyz(rgb)); }

/** Whole image → interleaved Float32 [L,a,b, L,a,b, …]. No per-pixel allocations (fast on multi-megapixel frames). */
export function imageToLab(frame: { width: number; height: number; data: Uint8ClampedArray }): Float32Array {
  const n = frame.width * frame.height;
  const out = new Float32Array(n * 3);
  const d = frame.data;
  for (let i = 0, p = 0, q = 0; i < n; i++, p += 4, q += 3) {
    const r = LINEAR[d[p]], g = LINEAR[d[p + 1]], b = LINEAR[d[p + 2]];
    const fx = f((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / D65[0]);
    const fy = f((r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / D65[1]);
    const fz = f((r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / D65[2]);
    out[q] = 116 * fy - 16;
    out[q + 1] = 500 * (fx - fy);
    out[q + 2] = 200 * (fy - fz);
  }
  return out;
}

/** CIELAB (D65) → sRGB 0–255, clamped. Used only to draw colour swatches. */
export function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t > DELTA ? t * t * t : 3 * DELTA * DELTA * (t - 4 / 29));
  const X = D65[0] * inv(fx), Y = D65[1] * inv(fy), Z = D65[2] * inv(fz);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  const enc = (c: number) => { const v = Math.max(0, Math.min(1, c)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
  return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
}
