/**
 * Shared measurement model, calibration maths and report export for PixMatch.
 */

import type { LAB } from "./color";
import type { DetectOptions, Pt, SegmentResult } from "./segmentation";
import type { Unit } from "./needle-gauge";
import type { ScientificFrameResult, ScientificRecipe } from "./scientific";

export type ToolId =
  | "select"
  | "line"
  | "angle"
  | "rect"
  | "oval"
  | "point"
  | "wand"
  | "hand";

export type Roi = { x: number; y: number; w: number; h: number };

export type Measurement = {
  id: string;
  label: string;
  type: "Line" | "Angle" | "Rectangle" | "Oval" | "Point" | "Region";
  points: Pt[];
  /** raw pixel quantities — physical values derive from the frame scale */
  lengthPx?: number;
  areaPx?: number;
  perimeterPx?: number;
  angleDeg?: number;
  feretMaxPx?: number;
  feretMinPx?: number;
  circularity?: number;
  meanLab?: LAB;
  deltaE?: number;
  rgb?: { r: number; g: number; b: number };
  contour?: Pt[];
  source: "manual" | "auto";
  strokeColor?: string;
  strokeWidth?: number;
};

export type Scale = {
  pxPerUnit: number; // 0 = uncalibrated
  unit: Unit;
  origin: "none" | "needle" | "known-distance" | "inherited";
  note: string;
};

export type FrameState = {
  id: string;
  name: string;
  url: string;
  sizeLabel: string;
  mode: "manual" | "auto";
  scale: Scale;
  measurements: Measurement[];
  /** ROIs committed with Edit > Draw / Ctrl+B; independent from result rows. */
  drawings?: Measurement[];
  analyzed: boolean;
  autoNote: string;
  scientific?: ScientificFrameResult[];
};

/**
 * The "recipe" learned from the reference frame — everything the user did by
 * hand, expressed in a frame-independent way so it can be replayed.
 */
export type RecipeStep = {
  label: string;
  type: Measurement["type"];
  /** Geometry is stored as 0..1 fractions so differently-sized frames work. */
  pointsRel: Pt[];
  /** Regions and probes relocate by colour before being reconstructed. */
  referenceLab?: LAB;
  detect?: DetectOptions;
  searchRadiusRel?: number;
};

export type Recipe = {
  /** Ordered manual measurements learned from reference image 1. */
  steps: RecipeStep[];
  scale: Scale;
  inheritScale: boolean;
  capturedFrom: string;
  capturedAt: string;
  scientific?: ScientificRecipe;
};

export const NO_SCALE: Scale = {
  pxPerUnit: 0,
  unit: "mm",
  origin: "none",
  note: "uncalibrated",
};

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function dist(a: Pt, b: Pt) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function angleBetween(a: Pt, v: Pt, b: Pt) {
  const a1 = Math.atan2(a.y - v.y, a.x - v.x);
  const a2 = Math.atan2(b.y - v.y, b.x - v.x);
  let deg = Math.abs((a1 - a2) * (180 / Math.PI));
  if (deg > 180) deg = 360 - deg;
  return deg;
}

export function toUnitLength(px: number | undefined, scale: Scale) {
  if (px == null) return null;
  if (!scale.pxPerUnit) return { value: px, unit: "px" as const };
  return { value: px / scale.pxPerUnit, unit: scale.unit };
}

export function toUnitArea(areaPx: number | undefined, scale: Scale) {
  if (areaPx == null) return null;
  if (!scale.pxPerUnit) return { value: areaPx, unit: "px²" };
  return { value: areaPx / (scale.pxPerUnit * scale.pxPerUnit), unit: `${scale.unit}²` };
}

export function fmt(n: number | null | undefined, digits = 3) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  return n.toFixed(digits);
}

export function measurementFromSegment(
  seg: SegmentResult,
  label: string,
  deltaE: number,
  source: "manual" | "auto",
): Measurement {
  return {
    id: newId(),
    label,
    type: "Region",
    points: [seg.centroid],
    areaPx: seg.areaPx,
    perimeterPx: seg.perimeterPx,
    feretMaxPx: seg.feretMax,
    feretMinPx: seg.feretMin,
    circularity: seg.circularity,
    meanLab: seg.meanLab,
    deltaE,
    contour: seg.contour,
    source,
  };
}

/** Rows shared by the results table and both exports. */
export function resultRows(frame: FrameState) {
  return frame.measurements.map((m, index) => {
    const len = toUnitLength(m.lengthPx ?? m.feretMaxPx, frame.scale);
    const area = toUnitArea(m.areaPx, frame.scale);
    const per = toUnitLength(m.perimeterPx, frame.scale);
    const minF = toUnitLength(m.feretMinPx, frame.scale);
    return {
      index: index + 1,
      frame: frame.name,
      label: m.label,
      type: m.type,
      source: m.source,
      length: len ? `${fmt(len.value)} ${len.unit}` : "—",
      area: area ? `${fmt(area.value)} ${area.unit}` : "—",
      perimeter: per ? `${fmt(per.value)} ${per.unit}` : "—",
      minFeret: minF ? `${fmt(minF.value)} ${minF.unit}` : "—",
      angle: m.angleDeg != null ? `${fmt(m.angleDeg, 2)}°` : "—",
      circularity: m.circularity != null ? fmt(m.circularity, 3) : "—",
      lab: m.meanLab
        ? `${fmt(m.meanLab.L, 1)} / ${fmt(m.meanLab.a, 1)} / ${fmt(m.meanLab.b, 1)}`
        : "—",
      deltaE: m.deltaE != null ? fmt(m.deltaE, 2) : "—",
    };
  });
}

const COLUMNS = [
  ["index", "#"],
  ["frame", "Frame"],
  ["label", "Label"],
  ["type", "Type"],
  ["source", "Mode"],
  ["length", "Length / Max Feret"],
  ["minFeret", "Min Feret"],
  ["area", "Area"],
  ["perimeter", "Perimeter"],
  ["angle", "Angle"],
  ["circularity", "Circ."],
  ["lab", "Mean L* a* b*"],
  ["deltaE", "ΔE"],
] as const;

export function exportCsv(frames: FrameState[]) {
  const head = COLUMNS.map(([, title]) => title).join(",");
  const lines = frames.flatMap((frame) =>
    resultRows(frame).map((row) =>
      COLUMNS.map(([key]) => `"${String((row as Record<string, unknown>)[key])}"`).join(","),
    ),
  );
  const scientificHead = "ScientificFrame,Phase,Role,HeightPx,HeightPhysical,ContactDiameterPx,ContactDiameterPhysical,TopY,BaselineY,Components,Confidence,Status";
  const scientificLines = frames.flatMap((frame, frameIndex) =>
    (frame.scientific ?? []).map((r) => [
      frameIndex + 1, r.phase, r.role, r.heightPx, r.heightPhysical,
      r.contactDiameterPx, r.contactDiameterPhysical, r.topY, r.baselineY,
      r.componentCount, r.confidence, r.status,
    ].map((v) => `"${String(v ?? "")}"`).join(",")),
  );
  return [head, ...lines, "", scientificHead, ...scientificLines].join("\n");
}

/** Full HTML report — the text results converted to a shareable document. */
export function exportHtml(frames: FrameState[], recipe: Recipe | null) {
  const rows = frames
    .flatMap((frame) => resultRows(frame))
    .map(
      (row) =>
        `<tr>${COLUMNS.map(([key]) => `<td>${String((row as Record<string, unknown>)[key])}</td>`).join("")}</tr>`,
    )
    .join("\n");

  const recipeBlock = recipe
    ? `<h2>Analysis recipe</h2><table class="kv">
<tr><th>Captured from</th><td>${recipe.capturedFrom}</td></tr>
<tr><th>Captured at</th><td>${recipe.capturedAt}</td></tr>
<tr><th>Workflow steps</th><td>${recipe.steps.length}</td></tr>
<tr><th>Measurements</th><td>${recipe.steps.map((step) => `${step.label} (${step.type})`).join(" → ")}</td></tr>
<tr><th>Scale</th><td>${recipe.scale.pxPerUnit ? `${fmt(recipe.scale.pxPerUnit, 3)} px / ${recipe.scale.unit} (${recipe.scale.origin})` : "uncalibrated"}</td></tr>
</table>`
    : "";

  const scientificRows = frames.flatMap((frame, frameIndex) =>
    (frame.scientific ?? []).map((r) => `<tr><td>${frameIndex + 1}</td><td>${r.phase}</td><td>${r.role}</td><td>${r.heightPhysical == null ? "—" : `${fmt(r.heightPhysical, 4)} ${frame.scale.unit}`}</td><td>${r.contactDiameterPhysical == null ? "—" : `${fmt(r.contactDiameterPhysical, 4)} ${frame.scale.unit}`}</td><td>${fmt(r.confidence * 100, 1)}%</td><td>${r.status}</td></tr>`).join(""),
  ).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>PixMatch analysis report</title>
<style>
 body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f3ef;color:#1c1c1c;margin:32px}
 h1{font-size:19px;margin:0 0 4px} h2{font-size:14px;margin:26px 0 8px;text-transform:uppercase;letter-spacing:.08em}
 .sub{color:#6b6b6b;margin:0 0 20px}
 table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #c9c6bd}
 th,td{border:1px solid #ddd9d0;padding:5px 8px;text-align:left;font-size:12px}
 thead th{background:#e6e3db}
 tbody tr:nth-child(even){background:#faf9f6}
 table.kv{width:auto} table.kv th{background:#e6e3db;text-align:right}
</style></head><body>
<h1>PixMatch analysis report</h1>
<p class="sub">${frames.length} frame(s) · generated ${new Date().toLocaleString()}</p>
${recipeBlock}
<h2>Measurements</h2>
<table><thead><tr>${COLUMNS.map(([, t]) => `<th>${t}</th>`).join("")}</tr></thead>
<tbody>${rows || `<tr><td colspan="${COLUMNS.length}">No measurements</td></tr>`}</tbody></table>
<h2>Scientific phase measurements</h2>
<table><thead><tr><th>Frame</th><th>Phase</th><th>Role</th><th>Height</th><th>Contact diameter</th><th>Confidence</th><th>Status</th></tr></thead>
<tbody>${scientificRows || `<tr><td colspan="7">No scientific measurements</td></tr>`}</tbody></table>
</body></html>`;
}

export function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
