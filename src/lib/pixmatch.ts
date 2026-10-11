/**
 * Shared measurement model, calibration maths and report export for PixMatch.
 */

import type { LAB } from "./color";
import type { DetectOptions, Pt, SegmentResult } from "./segmentation";
import type { Unit } from "./needle-gauge";
import type { ScientificAngleResult, ScientificFrameResult, ScientificLineResult, ScientificRecipe } from "./scientific";

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
  /** Lengths of user-defined "height" lines, re-located in this frame. */
  scientificLines?: ScientificLineResult[];
  /** User-defined angles (contact angle etc.), re-located and re-measured in this frame. */
  scientificAngles?: ScientificAngleResult[];
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

export type BatchFrameStatus = "VALID" | "MISSING_PHASE" | "INVALID_FRAME" | "SEGMENTATION_FAILED";

export type BatchFrameOutcome<T> = {
  index: number;
  name: string;
  status: BatchFrameStatus;
  value?: T;
  error?: string;
};

/**
 * Safe, yielding batch executor for image-analysis sequences. A bad frame is
 * represented as data instead of escaping the loop and crashing the run.
 */
export async function executeBatchSequence<T>(
  items: readonly { name: string }[],
  process: (item: { name: string }, index: number) => Promise<T> | T,
  options: {
    onProgress?: (index: number, total: number, item: { name: string }) => void;
    yieldEvery?: number;
    classifyError?: (error: unknown) => BatchFrameStatus;
    classifyValue?: (value: T) => BatchFrameStatus;
  } = {},
): Promise<BatchFrameOutcome<T>[]> {
  const outcomes: BatchFrameOutcome<T>[] = [];
  const yieldEvery = Math.max(1, Math.floor(options.yieldEvery ?? 1));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    options.onProgress?.(i, items.length, item);
    try {
      const value = await process(item, i);
      const status = options.classifyValue?.(value) ?? "VALID";
      outcomes.push({ index: i, name: item.name, status, value });
    } catch (error) {
      const status = options.classifyError?.(error) ?? "SEGMENTATION_FAILED";
      outcomes.push({
        index: i,
        name: item.name,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if ((i + 1) % yieldEvery === 0 && typeof requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }
  return outcomes;
}

export function validateImageData(data: ImageData | null | undefined): string | null {
  if (!data || !Number.isInteger(data.width) || !Number.isInteger(data.height) || data.width <= 0 || data.height <= 0) {
    return "Invalid image dimensions";
  }
  const expected = data.width * data.height * 4;
  if (!data.data || data.data.length !== expected) return `Invalid pixel buffer: expected ${expected}, received ${data.data?.length ?? 0}`;
  return null;
}

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
  const scientificHead = "ScientificFrame,Phase,Role,HeightPx,HeightPhysical,TopY,BottomY,PixelHeight,ContactDiameterPx,ContactDiameterPhysical,BaselineY,Components,Confidence,Status,OverlapPixels,AmbiguousPixels,ResolvedPixels";
  const scientificLines = frames.flatMap((frame, frameIndex) =>
    (frame.scientific ?? []).map((r) => [
      frameIndex + 1, r.phase, r.role, r.heightPx, r.heightPhysical,
      r.topY, r.bottomY, r.pixelHeight, r.contactDiameterPx, r.contactDiameterPhysical, r.baselineY,
      r.componentCount, r.confidence, r.status, r.interaction?.overlapPixels ?? 0, r.interaction?.ambiguousPixels ?? 0, r.interaction?.resolvedPixels ?? 0,
    ].map((v) => `"${String(v ?? "")}"`).join(",")),
  );
  const lineHead = "LineFrame,Line,LengthPx,LengthPhysical,Confidence,Status";
  const lineRows = frames.flatMap((frame, frameIndex) =>
    (frame.scientificLines ?? []).map((r) => [
      frameIndex + 1, r.label, r.lengthPx, r.lengthPhysical, r.confidence, r.status,
    ].map((v) => `"${String(v ?? "")}"`).join(",")),
  );
  const angleHead = "AngleFrame,Angle,AngleDeg,Method,Confidence,Status";
  const angleRows = frames.flatMap((frame, frameIndex) =>
    (frame.scientificAngles ?? []).map((r) => [
      frameIndex + 1, r.label, r.angleDeg, r.method, r.confidence, r.status,
    ].map((v) => `"${String(v ?? "")}"`).join(",")),
  );
  return [head, ...lines, "", scientificHead, ...scientificLines, "", lineHead, ...lineRows, "", angleHead, ...angleRows].join("\n");
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
<tr><th>Measurements</th><td>${recipe.steps.map((step) => `${step.label} (${step.type})`).join(" → ") || "Scientific phase workflow"}</td></tr>
<tr><th>Scientific phases</th><td>${recipe.scientific?.groups.length ?? 0}</td></tr>
<tr><th>CIELAB regions</th><td>${recipe.scientific?.groups.reduce((n, g) => n + g.components.length, 0) ?? 0}</td></tr>
<tr><th>Reference lines</th><td>${recipe.scientific?.lines.length ?? 0}</td></tr>
<tr><th>Interaction policy</th><td>${recipe.scientific?.interaction?.mode === "allow-overlaps" ? "Allow overlaps" : "Resolve competing phases"}</td></tr>
<tr><th>Scale</th><td>${recipe.scale.pxPerUnit ? `${fmt(recipe.scale.pxPerUnit, 3)} px / ${recipe.scale.unit} (${recipe.scale.origin})` : "uncalibrated"}</td></tr>
</table>`
    : "";

  const scientificRows = frames.flatMap((frame, frameIndex) =>
    (frame.scientific ?? []).map((r) => `<tr><td>${frameIndex + 1}</td><td>${r.phase}</td><td>${r.role}</td><td>${r.heightPhysical == null ? "—" : `${fmt(r.heightPhysical, 4)} ${frame.scale.unit}`}</td><td>${r.pixelHeight == null ? "—" : fmt(r.pixelHeight, 2)}</td><td>${r.contactDiameterPhysical == null ? "—" : `${fmt(r.contactDiameterPhysical, 4)} ${frame.scale.unit}`}</td><td>${fmt(r.confidence * 100, 1)}%</td><td>${r.status}</td><td>${r.interaction?.overlapPixels ?? 0}</td><td>${r.interaction?.ambiguousPixels ?? 0}</td></tr>`).join(""),
  ).join("\n");

  const lineTableRows = frames.flatMap((frame, frameIndex) =>
    (frame.scientificLines ?? []).map((r) => `<tr><td>${frameIndex + 1}</td><td>${r.label}</td><td>${r.lengthPhysical == null ? (r.lengthPx == null ? "—" : `${fmt(r.lengthPx, 2)} px`) : `${fmt(r.lengthPhysical, 4)} ${frame.scale.unit}`}</td><td>${fmt(r.confidence * 100, 1)}%</td><td>${r.status}</td></tr>`).join(""),
  ).join("\n");

  const angleTableRows = frames.flatMap((frame, frameIndex) =>
    (frame.scientificAngles ?? []).map((r) => `<tr><td>${frameIndex + 1}</td><td>${r.label}</td><td>${r.angleDeg == null ? "—" : `${fmt(r.angleDeg, 2)}°`}</td><td>${r.method ?? "—"}</td><td>${fmt(r.confidence * 100, 1)}%</td><td>${r.status}</td></tr>`).join(""),
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
<table><thead><tr><th>Frame</th><th>Phase</th><th>Role</th><th>Height</th><th>Pixel height</th><th>Contact diameter</th><th>Confidence</th><th>Status</th><th>Overlaps</th><th>Ambiguous</th></tr></thead>
<tbody>${scientificRows || `<tr><td colspan="10">No scientific measurements</td></tr>`}</tbody></table>
<h2>Tracked reference lines</h2>
<table><thead><tr><th>Frame</th><th>Line</th><th>Length</th><th>Confidence</th><th>Status</th></tr></thead>
<tbody>${lineTableRows || `<tr><td colspan="5">No tracked lines</td></tr>`}</tbody></table>
<h2>Tracked angles (e.g. contact angle)</h2>
<table><thead><tr><th>Frame</th><th>Angle</th><th>Value</th><th>Method</th><th>Confidence</th><th>Status</th></tr></thead>
<tbody>${angleTableRows || `<tr><td colspan="6">No tracked angles</td></tr>`}</tbody></table>
</body></html>`;
}


/** Excel-compatible workbook using SpreadsheetML (opens directly in Excel/LibreOffice). */
export function exportExcel(frames: FrameState[]) {
  const rows = frames.flatMap((frame) => resultRows(frame));
  const headers = COLUMNS.map(([, title]) => title);
  const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cells = (values: unknown[]) => values.map((v) => `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`).join("");
  const scientific = frames.flatMap((frame, i) => (frame.scientific ?? []).map((r) => [i + 1, frame.name, r.phase, r.role, r.heightPx, r.heightPhysical, r.pixelHeight, r.contactDiameterPx, r.contactDiameterPhysical, r.confidence, r.status, r.interaction?.overlapPixels ?? 0, r.interaction?.ambiguousPixels ?? 0]));
  const trackedRows = [
    ...frames.flatMap((frame, i) => (frame.scientificLines ?? []).map((r) => [i + 1, frame.name, r.label, "length", r.lengthPx, r.lengthPhysical, "", r.confidence, r.status])),
    ...frames.flatMap((frame, i) => (frame.scientificAngles ?? []).map((r) => [i + 1, frame.name, r.label, "angle", "", "", r.angleDeg, r.confidence, r.status])),
  ];
  const pivNote = "PIV vectors are exported separately as CSV from the Download menu.";
  return `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="Header"><Font ss:Bold="1"/></Style></Styles>
<Worksheet ss:Name="Measurements"><Table>
<Row ss:StyleID="Header">${cells(headers)}</Row>
${rows.map((r) => `<Row>${cells(headers.map((_, i) => r[ COLUMNS[i][0] as keyof typeof r ]))}</Row>`).join("\n")}
</Table></Worksheet>
<Worksheet ss:Name="Scientific"><Table>
<Row ss:StyleID="Header">${cells(["#","Frame","Phase","Role","Height px","Height physical","Pixel height","Contact diameter px","Contact diameter physical","Confidence","Status","Overlap pixels","Ambiguous pixels"])}</Row>
${scientific.map((r) => `<Row>${cells(r)}</Row>`).join("\n")}
</Table></Worksheet>
<Worksheet ss:Name="Tracked quantities"><Table>
<Row ss:StyleID="Header">${cells(["Frame #","Frame","Quantity","Kind","Length px","Length physical","Angle deg","Confidence","Status"])}</Row>
${trackedRows.map((r) => `<Row>${cells(r)}</Row>`).join("\n")}
</Table></Worksheet>
<Worksheet ss:Name="Notes"><Table><Row>${cells([pivNote])}</Row></Table></Worksheet>
</Workbook>`;
}

/** A small self-contained PDF report; avoids a runtime dependency on a PDF library. */
export function exportPdf(frames: FrameState[], recipe: Recipe | null) {
  const lines = [
    "PixMatch analysis report",
    `${frames.length} frame(s)`,
    recipe ? `Reference: ${recipe.capturedFrom}` : "No captured recipe",
    `Measurements: ${frames.reduce((n, f) => n + f.measurements.length, 0)}`,
    `Scientific results: ${frames.reduce((n, f) => n + (f.scientific?.length ?? 0), 0)}`,
    "",
    ...frames.flatMap((f, i) => (f.scientific ?? []).map((r) => `Frame ${i + 1} | ${f.name} | ${r.phase} | ${r.role} | height=${r.heightPhysical == null ? "-" : fmt(r.heightPhysical, 4)} ${f.scale.unit} | status=${r.status}`)),
  ];
  const safe = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = ["BT", "/F1 10 Tf", "50 760 Td", ...lines.map((line, i) => `${i ? "0 -14 Td" : ""} (${safe(line.slice(0, 130))}) Tj`), "ET"].join("\n");
  const objs = [
    `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n`,
    `2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n`,
    `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>endobj\n`,
    `4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n`,
    `5 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objs) { offsets.push(pdf.length); pdf += obj; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

/** Render the scientific series as a standalone PNG using an offscreen canvas. */
export function exportGraphPng(frames: FrameState[], title = "PixMatch scientific measurements"): Promise<Blob> {
  const width = 1400, height = 760;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas unavailable"));
  ctx.fillStyle = "#07111f"; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#dce9ff"; ctx.font = "bold 24px system-ui"; ctx.fillText(title, 50, 55);
  const series = frames.flatMap((f, i) => (f.scientific ?? []).filter((r) => Number.isFinite(r.heightPhysical)).map((r) => ({ x: i + 1, y: r.heightPhysical as number, phase: r.phase })));
  const x0 = 90, y0 = 90, w = 1240, h = 580;
  ctx.strokeStyle = "#36506f"; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, w, h);
  if (!series.length) { ctx.fillStyle = "#91a4bf"; ctx.font = "18px system-ui"; ctx.fillText("No finite scientific height measurements available.", x0 + 30, y0 + 50); return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png")); }
  const ys = series.map((p) => p.y), ymin = Math.min(...ys), ymax = Math.max(...ys), yr = ymax - ymin || 1;
  ctx.strokeStyle = "#263b54"; ctx.fillStyle = "#8fa4bd"; ctx.font = "14px system-ui";
  for (let i = 0; i <= 5; i++) { const yy = y0 + h - i * h / 5; const val = ymin + yr * i / 5; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x0 + w, yy); ctx.stroke(); ctx.fillText(val.toFixed(4), 10, yy + 5); }
  ctx.beginPath();
  series.forEach((p, j) => { const px = x0 + (series.length === 1 ? w / 2 : (p.x - 1) / Math.max(1, frames.length - 1) * w); const py = y0 + h - (p.y - ymin) / yr * h; if (!j) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
  ctx.strokeStyle = "#48a7ff"; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = "#b9d9ff"; series.forEach((p) => { const px = x0 + (series.length === 1 ? w / 2 : (p.x - 1) / Math.max(1, frames.length - 1) * w); const py = y0 + h - (p.y - ymin) / yr * h; ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = "#91a4bf"; ctx.fillText("Frame", x0 + w / 2 - 20, height - 35); ctx.save(); ctx.translate(25, y0 + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("Physical height", 0, 0); ctx.restore();
  return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png"));
}

export function download(filename: string, content: string | Blob, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  requestAnimationFrame(() => {
    a.click();
    window.setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1500);
  });
}
