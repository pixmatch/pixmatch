/**
 * Color science helpers: sRGB -> CIE XYZ -> CIELAB, plus color difference
 * metrics used by the boundary/segmentation engine.
 */

export type RGB = { r: number; g: number; b: number };
export type LAB = { L: number; a: number; b: number };

const REF_X = 95.047;
const REF_Y = 100.0;
const REF_Z = 108.883;

// IEC 61966-2-1 sRGB -> XYZ (D65), expressed for XYZ scaled to 0..100.
const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
] as const;

function srgbToLinear(c: number) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function pivot(t: number) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(r: number, g: number, b: number): LAB {
  const rl = srgbToLinear(r) * 100;
  const gl = srgbToLinear(g) * 100;
  const bl = srgbToLinear(b) * 100;

  const x = pivot((rl * SRGB_TO_XYZ[0][0] + gl * SRGB_TO_XYZ[0][1] + bl * SRGB_TO_XYZ[0][2]) / REF_X);
  const y = pivot((rl * SRGB_TO_XYZ[1][0] + gl * SRGB_TO_XYZ[1][1] + bl * SRGB_TO_XYZ[1][2]) / REF_Y);
  const z = pivot((rl * SRGB_TO_XYZ[2][0] + gl * SRGB_TO_XYZ[2][1] + bl * SRGB_TO_XYZ[2][2]) / REF_Z);

  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

/** Fast CIE76 difference — good enough for interactive previews. */
export function deltaE76(p: LAB, q: LAB) {
  return Math.sqrt((p.L - q.L) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2);
}

/** CIEDE2000 — perceptually accurate, used for final boundary detection. */
export function deltaE2000(p: LAB, q: LAB) {
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(p.a, p.b);
  const C2 = Math.hypot(q.a, q.b);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * p.a;
  const a2p = (1 + G) * q.a;
  const C1p = Math.hypot(a1p, p.b);
  const C2p = Math.hypot(a2p, q.b);
  const h1p = (Math.atan2(p.b, a1p) * 180) / Math.PI;
  const h2p = (Math.atan2(q.b, a2p) * 180) / Math.PI;
  const h1 = h1p < 0 ? h1p + 360 : h1p;
  const h2 = h2p < 0 ? h2p + 360 : h2p;

  const dLp = q.L - p.L;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2 - h1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

  const Lbarp = (p.L + q.L) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1 + h2;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1 - h2) > 180) hbarp += h1 + h2 < 360 ? 360 : -360;
    hbarp /= 2;
  }

  const T =
    1 -
    0.17 * Math.cos(((hbarp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hbarp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbarp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbarp - 63) * Math.PI) / 180);

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;

  const termL = dLp / (kL * Sl);
  const termC = dCp / (kC * Sc);
  const termH = dHp / (kH * Sh);
  // Floating-point roundoff can make the CIEDE2000 quadratic form tiny-negative
  // for nearly identical colours. Clamp rather than ever exposing NaN.
  const squared = Math.max(0, termL * termL + termC * termC + termH * termH + Rt * termC * termH);
  const result = Math.sqrt(squared);
  return Number.isFinite(result) ? result : 0;
}

export function labDistance(p: LAB, q: LAB, metric: "cie76" | "ciede2000") {
  return metric === "cie76" ? deltaE76(p, q) : deltaE2000(p, q);
}

/**
 * ΔE with an adjustable lightness weight (0..1). Lowering it makes matching tolerant to
 * exposure / illumination drift between frames while still separating phases by hue and chroma.
 */
export function labDistanceW(p: LAB, q: LAB, metric: "cie76" | "ciede2000", lightnessWeight = 1) {
  if (lightnessWeight >= 1) return labDistance(p, q, metric);
  const w = Math.max(0, lightnessWeight);
  return labDistance(p, { L: p.L + (q.L - p.L) * w, a: q.a, b: q.b }, metric);
}

export function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Luminance in the 0..255 ImageJ "Value" sense (weighted grayscale). */
export function grayValue(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
