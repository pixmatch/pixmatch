import { createFileRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Aperture,
  Crosshair,
  Download,
  Hand,
  MousePointer2,
  Move,
  Ruler,
  Square,
  Circle,
  Triangle,
  Wand2,
  Pencil,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { grayValue, rgbToHex, rgbToLab, labDistance, type LAB } from "@/lib/color";
import { DEFAULT_PIV, computePivPair, exportPivCsv, vectorPhysical, type PivConfig, type PivPairResult } from "@/lib/piv";
import {
  DEFAULT_DETECT,
  detectRegion,
  borderStats,
  channelHistogram,
  normalizeToReference,
  regionLimits,
  relocateSeed,
  relocateSeedWithSoftPrior,
  toLabField,
  type ChannelId,
  type DetectOptions,
  type LabField,
  type Pt,
  type SegmentResult,
} from "@/lib/segmentation";
import {
  NO_SCALE,
  angleBetween,
  dist,
  download,
  exportCsv,
  exportHtml,
  exportExcel,
  exportPdf,
  exportGraphPng,
  executeBatchSequence,
  validateImageData,
  fmt,
  formatSize,
  measurementFromSegment,
  newId,
  toUnitArea,
  toUnitLength,
  type FrameState,
  type Measurement,
  type Recipe,
  type RecipeStep,
  type Scale,
  type ToolId,
} from "@/lib/pixmatch";
import { CalibrationPanel } from "@/components/pixmatch/CalibrationPanel";
import { DetectPanel } from "@/components/pixmatch/DetectPanel";
import { ResultsTable } from "@/components/pixmatch/ResultsTable";
import { HistogramView } from "@/components/pixmatch/HistogramView";
import { removeStoredImage, restoreImages, storeImages } from "@/lib/frame-storage";
import {
  captureAngleAnchors,
  captureLineAnchors,
  captureWedge,
  measureScientificPhase,
  trackAngle,
  segmentScientificGroups,
  trackHeightLine,
  type ScientificAngle,
  type ScientificLine,
  type ScientificLineRole,
  type ScientificRecipe,
} from "@/lib/scientific";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PixMatch - Fluid Mechanics Image Analyzer" },
      {
        name: "description",
        content:
          "Calibrate with a needle gauge, trace phases with CIELAB boundary detection, then replay the same recipe automatically across an entire image sequence.",
      },
      { property: "og:title", content: "PixMatch - Fluid Mechanics Image Analyzer" },
      {
        property: "og:description",
        content:
          "Reference-driven measurement, CIELAB/RGB phase tracking, bulk sequence analysis and PIV-style image velocimetry.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Workspace,
});

const CW = 900;
const CH = 580;
const LOUPE = 150;

type FrameData = {
  img: HTMLImageElement;
  data: ImageData;
  field: LabField;
  width: number;
  height: number;
};

/** A user-defined physical phase in the scientific composition panel. */
type ScientificPhaseDef = {
  id: string;
  name: string;
  role: "target" | "secondary";
  color: string;
};

/** Carry-over between consecutive frames: last phase seeds and last endpoint positions. */
type ScientificTrack = { seeds: Map<string, Pt>; endpoints: Map<string, [Pt, Pt]>; angles?: Map<string, [Pt, Pt, Pt]>; illumRef?: LAB | null; lastStatus?: "VALID" | "MISSING_PHASE" | "INVALID_FRAME" | "SEGMENTATION_FAILED" };

/** What the user can define on the reference frame. Each one is replayed on every frame. */
type QtyKind = "height-line" | "diameter-line" | "length-line" | "contact-angle" | "angle" | "extent" | "base" | "chord";
const QTY: Record<QtyKind, { label: string; shape: "line" | "angle"; role?: ScientificLineRole; defaultName: string; done: string }> = {
  "height-line": { label: "Height — line", shape: "line", role: "length", defaultName: "Height", done: "Height line saved. Both ends are re-located in every frame and the new length is reported." },
  "diameter-line": { label: "Diameter / width — line", shape: "line", role: "length", defaultName: "Diameter", done: "Diameter line saved. Both ends are re-located in every frame and the new length is reported." },
  "length-line": { label: "Other length — line (name it)", shape: "line", role: "length", defaultName: "Length", done: "Length line saved and will be tracked in every frame." },
  "contact-angle": { label: "Contact angle — angle (3 points)", shape: "angle", defaultName: "Contact angle", done: "Contact angle saved. Vertex = contact point, arm 1 along the solid surface (toward the drop), arm 2 roughly along the interface. In every frame the phase inside the wedge is segmented and the boundary tangent at the contact point is measured." },
  angle: { label: "Other angle — 3 points (name it)", shape: "angle", defaultName: "Angle", done: "Angle saved. Its three points are re-located in every frame and the angle is recomputed." },
  extent: { label: "Phase extent along this axis (needs phase)", shape: "line", role: "height", defaultName: "Phase extent", done: "Measurement axis captured. The target phase extent will be recomputed from the current phase mask along this axis on every frame." },
  base: { label: "Base level (needs phase)", shape: "line", role: "base", defaultName: "Base level", done: "Base level captured. The target phase extent will be measured from its top boundary to this level." },
  chord: { label: "Chord span / contact width (needs phase)", shape: "line", role: "chord", defaultName: "Chord span", done: "Chord line captured. The width of the target phase along this line will be measured in every frame." },
};

type Selection =
  | { type: "Line"; points: Pt[] }
  | { type: "Angle"; points: Pt[] }
  | { type: "Rectangle"; points: Pt[] }
  | { type: "Oval"; points: Pt[] }
  | { type: "Point"; points: Pt[] }
  | { type: "Region"; points: Pt[]; seg: SegmentResult; deltaE: number };

const TOOLS: { id: ToolId; label: string; hint: string; Icon: typeof Ruler }[] = [
  { id: "select", label: "Select", hint: "Pick a measurement", Icon: MousePointer2 },
  { id: "line", label: "Straight line", hint: "Drag a line — length & angle", Icon: Ruler },
  { id: "angle", label: "Angle", hint: "Three clicks: arm, vertex, arm", Icon: Triangle },
  { id: "rect", label: "Rectangle", hint: "Drag a rectangular ROI", Icon: Square },
  { id: "oval", label: "Oval", hint: "Drag an elliptical ROI", Icon: Circle },
  { id: "point", label: "Point / probe", hint: "Click to log RGB + L*a*b*", Icon: Crosshair },
  { id: "wand", label: "Wand (CIELAB)", hint: "Click a phase to trace its boundary", Icon: Wand2 },
  { id: "hand", label: "Pan", hint: "Drag to move the canvas", Icon: Hand },
];

function colorFor(type: Measurement["type"]) {
  if (type === "Region") return "#f25f4b";
  if (type === "Point") return "#f7c948";
  if (type === "Angle") return "#7ee787";
  return "#3b82f6";
}

function Workspace() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef(new Map<string, FrameData>());

  const [frames, setFrames] = useState<FrameState[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [tool, setTool] = useState<ToolId>("line");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<Pt[] | null>(null);
  const [anglePts, setAnglePts] = useState<Pt[]>([]);
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 });
  const panStart = useRef<{ pointer: Pt; pan: Pt } | null>(null);
  const [detect, setDetect] = useState<DetectOptions>(DEFAULT_DETECT);
  const [searchRadius, setSearchRadius] = useState(48);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [probe, setProbe] = useState<
    { x: number; y: number; rgb: { r: number; g: number; b: number }; lab: LAB } | null
  >(null);
  const [cursorView, setCursorView] = useState<Pt | null>(null);
  const [loupeOn, setLoupeOn] = useState(true);
  const [loupeZoom, setLoupeZoom] = useState(4);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showHistogram, setShowHistogram] = useState(true);
  const [autoMeasure, setAutoMeasure] = useState(false);
  const [lastSelection, setLastSelection] = useState<Selection | null>(null);
  const [bins, setBins] = useState<Uint32Array | null>(null);
  const [ready, setReady] = useState(0);
  const [status, setStatus] = useState("Open an image sequence to begin.");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const [frameMenu, setFrameMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [calibrationInstruction, setCalibrationInstruction] = useState<string | null>(null);
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [phases, setPhases] = useState<ScientificPhaseDef[]>([{ id: newId(), name: "Phase 1", role: "target", color: "#ff4d6d" }]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string>(() => phases[0].id);
  const [phaseTraceVisible, setPhaseTraceVisible] = useState<Record<string, boolean>>({});
  const [traceScope, setTraceScope] = useState<"selected" | "all">("selected");
  const [scientificRecipe, setScientificRecipe] = useState<ScientificRecipe | null>(null);
  const [lineRole, setLineRole] = useState<ScientificLineRole>("height");
  const [qtyKind, setQtyKind] = useState<QtyKind>("height-line");
  const [qtyName, setQtyName] = useState("");
  const [histChannel, setHistChannel] = useState<ChannelId>("gray");
  const [matchIllumination, setMatchIllumination] = useState(false);
  const [pivConfig, setPivConfig] = useState<PivConfig>(DEFAULT_PIV);
  const [pivResults, setPivResults] = useState<PivPairResult[]>([]);
  const [isRunningPiv, setIsRunningPiv] = useState(false);
  const undoStackRef = useRef<any[]>([]);
  const lastUndoKeyRef = useRef<string | null>(null);
  const restoringUndoRef = useRef(false);

  const frame = frames[activeIndex];
  const frameData = frame ? cacheRef.current.get(frame.id) : undefined;
  const hasImage = Boolean(frame && frameData);
  /** A line is "selected" if it is either the temporary selection or a committed mark that was clicked. */
  const selectedLinePoints: Pt[] | null = (() => {
    const committed = selectedId ? frame?.drawings?.find((m) => m.id === selectedId && m.type === "Line") : undefined;
    if (committed) return committed.points;
    return selection?.type === "Line" ? selection.points : null;
  })();

  /** An angle is "selected" if it is the temporary selection or a clicked committed mark. */
  const selectedAnglePoints: Pt[] | null = (() => {
    const committed = selectedId ? frame?.drawings?.find((m) => m.id === selectedId && m.type === "Angle") : undefined;
    if (committed) return committed.points;
    return selection?.type === "Angle" ? selection.points : null;
  })();

  // Lightweight application history. Transient probe/cursor/status state is deliberately excluded.
  useEffect(() => {
    const snapshot = {
      frames, activeIndex, tool, zoom, pan, detect, searchRadius, recipe, selectedId,
      loupeOn, loupeZoom, showOverlay, showHistogram, autoMeasure, phases, selectedPhaseId,
      phaseTraceVisible, traceScope, scientificRecipe, lineRole, matchIllumination, pivConfig, pivResults,
    };
    const key = JSON.stringify(snapshot);
    if (lastUndoKeyRef.current == null) {
      lastUndoKeyRef.current = key;
      return;
    }
    if (key !== lastUndoKeyRef.current) {
      if (!restoringUndoRef.current) {
        try {
          const previous = JSON.parse(lastUndoKeyRef.current);
          undoStackRef.current.push(previous);
          if (undoStackRef.current.length > 30) undoStackRef.current.shift();
        } catch { /* keep the app usable if a browser cannot serialize a value */ }
      }
      lastUndoKeyRef.current = key;
      if (restoringUndoRef.current) restoringUndoRef.current = false;
    }
  }, [frames, activeIndex, tool, zoom, pan, detect, searchRadius, recipe, selectedId, loupeOn, loupeZoom, showOverlay, showHistogram, autoMeasure, phases, selectedPhaseId, phaseTraceVisible, traceScope, scientificRecipe, lineRole, matchIllumination, pivConfig, pivResults]);

  function undoLastAction() {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) { setStatus("Nothing to undo."); return; }
    restoringUndoRef.current = true;
    setFrames(snapshot.frames); setActiveIndex(snapshot.activeIndex); setTool(snapshot.tool); setZoom(snapshot.zoom); setPan(snapshot.pan); setDetect(snapshot.detect);
    setSearchRadius(snapshot.searchRadius); setRecipe(snapshot.recipe); setSelectedId(snapshot.selectedId); setLoupeOn(snapshot.loupeOn);
    setLoupeZoom(snapshot.loupeZoom); setShowOverlay(snapshot.showOverlay); setShowHistogram(snapshot.showHistogram); setAutoMeasure(snapshot.autoMeasure);
    setPhases(snapshot.phases); setSelectedPhaseId(snapshot.selectedPhaseId);
    setPhaseTraceVisible(snapshot.phaseTraceVisible); setTraceScope(snapshot.traceScope); setScientificRecipe(snapshot.scientificRecipe);
    setLineRole(snapshot.lineRole); setMatchIllumination(snapshot.matchIllumination); setPivConfig(snapshot.pivConfig); setPivResults(snapshot.pivResults);
    setContextMenu(null); setOpenMenu(null); setFrameMenu(null); setStatus("Undid the last action.");
  }

  /* ---------------- image loading ---------------- */

  const loadFrame = useCallback(async (target: FrameState) => {
    if (cacheRef.current.has(target.id)) return cacheRef.current.get(target.id)!;
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Could not read ${target.name}`));
      img.src = target.url;
    });
    const off = document.createElement("canvas");
    off.width = img.naturalWidth;
    off.height = img.naturalHeight;
    const ctx = off.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height);
    const entry: FrameData = {
      img,
      data,
      field: toLabField(data),
      width: off.width,
      height: off.height,
    };
    cacheRef.current.set(target.id, entry);
    return entry;
  }, []);

  useEffect(() => {
    if (!frame || cacheRef.current.has(frame.id)) return;
    let cancelled = false;
    setStatus(`Reading ${frame.name}…`);
    loadFrame(frame)
      .then(() => {
        if (cancelled) return;
        setReady((n) => n + 1);
        setStatus(`${frame.name} loaded.`);
      })
      .catch((error: Error) => setStatus(error.message));
    return () => {
      cancelled = true;
    };
  }, [frame, loadFrame]);

  /* ---------------- view transform ---------------- */

  const view = useMemo(() => {
    if (!frameData) return { s: 1, ox: 0, oy: 0 };
    const fit = Math.min(CW / frameData.width, CH / frameData.height);
    const s = fit * (zoom / 100);
    return {
      s,
      ox: (CW - frameData.width * s) / 2 + pan.x,
      oy: (CH - frameData.height * s) / 2 + pan.y,
    };
  }, [frameData, zoom, pan]);

  const toView = useCallback((p: Pt) => ({ x: p.x * view.s + view.ox, y: p.y * view.s + view.oy }), [view]);
  const toImage = useCallback(
    (p: Pt) => ({ x: (p.x - view.ox) / view.s, y: (p.y - view.oy) / view.s }),
    [view],
  );

  /* ---------------- rendering ---------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    canvas.width = CW;
    canvas.height = CH;
    ctx.fillStyle = "#333a40";
    ctx.fillRect(0, 0, CW, CH);

    if (!frameData) {
      ctx.strokeStyle = "rgba(255,255,255,.07)";
      for (let x = 0; x < CW; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, CH);
        ctx.stroke();
      }
      for (let y = 0; y < CH; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(CW, y);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(230,235,238,.8)";
      ctx.font = "13px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("File ▸ Open images…", CW / 2, CH / 2);
      return;
    }

    ctx.imageSmoothingEnabled = view.s < 1;
    ctx.drawImage(
      frameData.img,
      view.ox,
      view.oy,
      frameData.width * view.s,
      frameData.height * view.s,
    );

    if (!showOverlay) return;

    const items = frame?.drawings ?? [];
    for (const m of items) drawMeasurement(ctx, m, m.id === selectedId);

    // Persistent CIELAB reference overlays. They are rendered from the stored contours,
    // not from the temporary Wand selection. Selected phase is the default scope; the UI
    // can switch to all phases.
    if (activeIndex === 0 && scientificRecipe?.groups.length) {
      const selectedPhase = phases.find((p) => p.id === selectedPhaseId);
      const groupsToDraw = traceScope === "all"
        ? scientificRecipe.groups
        : scientificRecipe.groups.filter((g) => selectedPhase && g.name.toLowerCase() === selectedPhase.name.toLowerCase() && g.role === selectedPhase.role);
      for (const group of groupsToDraw) {
        const phase = phases.find((p) => p.name.toLowerCase() === group.name.toLowerCase() && p.role === group.role);
        const visible = phase ? (phaseTraceVisible[phase.id] ?? group.traceVisible ?? true) : (group.traceVisible ?? true);
        if (!visible) continue;
        const color = group.traceColor ?? phase?.color ?? phaseTraceColor(scientificRecipe.groups.findIndex((g) => g.id === group.id));
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = Math.max(1, group.traceWidth ?? 2.5);
        if (group.traceDashed) ctx.setLineDash([9, 6]);
        for (const component of group.components) {
          const contour = component.contourRel?.map((p) => ({ x: p.x * frameData.width, y: p.y * frameData.height })) ?? [];
          if (!contour.length) {
            const seed = component.pointsRel?.[0];
            if (seed) {
              const v = toView({ x: seed.x * frameData.width, y: seed.y * frameData.height });
              ctx.beginPath(); ctx.arc(v.x, v.y, 6, 0, Math.PI * 2); ctx.stroke();
            }
            continue;
          }
          traceContour(ctx, contour);
          ctx.globalAlpha = 0.08;
          ctx.fill();
          ctx.globalAlpha = 0.95;
          traceContour(ctx, contour);
        }
        ctx.restore();
      }
    }

    const sci = frame?.scientific ?? [];
    for (const result of sci) {
      if (!result.contour?.length) continue;
      ctx.save();
      ctx.strokeStyle = result.role === "target" ? "#ff4d6d" : "#7dd3fc";
      ctx.fillStyle = result.role === "target" ? "rgba(255,77,109,.12)" : "rgba(125,211,252,.08)";
      ctx.lineWidth = 2;
      traceContour(ctx, result.contour);
      ctx.fill();
      ctx.stroke();
      if (result.role === "target" && result.baselineY != null && result.topY != null) {
        const yb = toView({ x: 0, y: result.baselineY }).y;
        const yt = toView({ x: 0, y: result.topY }).y;
        const xc = frameData.width * 0.5;
        const xv = toView({ x: xc, y: 0 }).x;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = "#ffe066";
        ctx.beginPath();
        ctx.moveTo(0, yb); ctx.lineTo(CW, yb); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(xv, yt); ctx.lineTo(xv, yb); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffe066";
        ctx.font = "11px ui-monospace, monospace";
        const h = result.heightPhysical != null ? `${result.heightPhysical.toFixed(3)} ${frame.scale.unit}` : `${result.heightPx?.toFixed(1) ?? "—"} px`;
        ctx.fillText(`${result.phase}: ${h}`, Math.min(CW - 180, Math.max(8, xv + 8)), (yt + yb) / 2);
      }
      ctx.restore();
    }
    for (const lr of frame?.scientificLines ?? []) {
      if (!lr.p1 || !lr.p2) continue;
      const a = toView(lr.p1), b = toView(lr.p2);
      ctx.save();
      ctx.strokeStyle = "#ffe066";
      ctx.fillStyle = "#ffe066";
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      for (const v of [a, b]) { ctx.beginPath(); ctx.arc(v.x, v.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.font = "11px ui-monospace, monospace";
      const txt = lr.lengthPhysical != null ? `${lr.lengthPhysical.toFixed(3)} ${frame?.scale.unit ?? ""}` : `${lr.lengthPx?.toFixed(1) ?? "—"} px`;
      ctx.fillText(`${lr.label}: ${txt}`, Math.min(CW - 190, Math.max(8, (a.x + b.x) / 2 + 8)), (a.y + b.y) / 2);
      ctx.restore();
    }
    for (const ar of frame?.scientificAngles ?? []) {
      if (!ar.p1 || !ar.vertex || !ar.p2 || ar.angleDeg == null) continue;
      const a = toView(ar.p1), v = toView(ar.vertex), b = toView(ar.p2);
      ctx.save();
      ctx.strokeStyle = "#7CFFB2";
      ctx.fillStyle = "#7CFFB2";
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(v.x, v.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const a1 = Math.atan2(a.y - v.y, a.x - v.x), a2 = Math.atan2(b.y - v.y, b.x - v.x);
      let d = a2 - a1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(v.x, v.y, 22, a1, a1 + d, d < 0); ctx.stroke();
      for (const q of [a, v, b]) { ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(`${ar.label}: ${ar.angleDeg.toFixed(1)}°`, Math.min(CW - 190, Math.max(8, v.x + 28)), v.y - 8);
      ctx.restore();
    }
    const pivOverlay = pivResults.find((r) => r.frameA === activeIndex);
    if (pivOverlay) {
      ctx.save();
      ctx.lineWidth = 1.2;
      const maxArrow = 34;
      for (const v of pivOverlay.vectors) {
        if (!v.valid) continue;
        const a = toView({ x: v.x, y: v.y });
        const scaleArrow = maxArrow / Math.max(1, Math.max(Math.abs(v.u), Math.abs(v.v)));
        const b = toView({ x: v.x + v.u * scaleArrow, y: v.y + v.v * scaleArrow });
        ctx.strokeStyle = v.correlation >= 0.65 ? "#00e5ff" : "#ffd166";
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const ah = 5;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - ah * Math.cos(ang - 0.45), b.y - ah * Math.sin(ang - 0.45));
        ctx.lineTo(b.x - ah * Math.cos(ang + 0.45), b.y - ah * Math.sin(ang + 0.45));
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    if (selection) drawSelection(ctx, selection);
    if (draft && draft.length === 2) {
      ctx.save();
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([4, 3]);
      strokeShape(ctx, tool, draft);
      ctx.restore();
    }
    if (anglePts.length) {
      ctx.save();
      ctx.strokeStyle = "#9ad14b";
      ctx.fillStyle = "#9ad14b";
      anglePts.forEach((p) => {
        const v = toView(p);
        ctx.beginPath();
        ctx.arc(v.x, v.y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }

    function strokeShape(c: CanvasRenderingContext2D, kind: ToolId, pts: Pt[]) {
      const a = toView(pts[0]);
      const b = toView(pts[1]);
      c.lineWidth = 1.5;
      c.beginPath();
      if (kind === "rect") c.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      else if (kind === "oval")
        c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      else {
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
      }
      c.stroke();
    }

    function drawSelection(c: CanvasRenderingContext2D, sel: Selection) {
      c.save();
      c.strokeStyle = "#ffe066";
      c.setLineDash([5, 3]);
      c.lineWidth = 1.5;
      if (sel.type === "Region") {
        traceContour(c, sel.seg.contour);
      } else if (sel.type === "Rectangle" || sel.type === "Oval") {
        strokeShape(c, sel.type === "Rectangle" ? "rect" : "oval", sel.points);
      } else if (sel.points.length >= 2) {
        c.beginPath();
        sel.points.forEach((p, i) => {
          const v = toView(p);
          if (i === 0) c.moveTo(v.x, v.y);
          else c.lineTo(v.x, v.y);
        });
        c.stroke();
      } else if (sel.points.length === 1) {
        const v = toView(sel.points[0]);
        c.beginPath();
        c.arc(v.x, v.y, 5, 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
    }

    function traceContour(c: CanvasRenderingContext2D, contour: Pt[]) {
      if (!contour.length) return;
      c.beginPath();
      contour.forEach((p, i) => {
        const v = toView(p);
        if (i === 0) c.moveTo(v.x, v.y);
        else c.lineTo(v.x, v.y);
      });
      c.closePath();
      c.stroke();
    }

    function drawMeasurement(c: CanvasRenderingContext2D, m: Measurement, active: boolean) {
      c.save();
      const color = m.strokeColor ?? colorFor(m.type);
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineWidth = active ? Math.max(3, m.strokeWidth ?? 1.6) : (m.strokeWidth ?? 1.6);
      if (m.type === "Region" && m.contour?.length) {
        traceContour(c, m.contour);
        c.globalAlpha = 0.18;
        c.fill();
        c.globalAlpha = 1;
      } else if (m.type === "Rectangle" || m.type === "Oval") {
        strokeShape(c, m.type === "Rectangle" ? "rect" : "oval", m.points);
      } else if (m.type === "Point") {
        const v = toView(m.points[0]);
        c.beginPath();
        c.moveTo(v.x - 6, v.y);
        c.lineTo(v.x + 6, v.y);
        c.moveTo(v.x, v.y - 6);
        c.lineTo(v.x, v.y + 6);
        c.stroke();
      } else {
        c.beginPath();
        m.points.forEach((p, i) => {
          const v = toView(p);
          if (i === 0) c.moveTo(v.x, v.y);
          else c.lineTo(v.x, v.y);
        });
        c.stroke();
        m.points.forEach((p) => {
          const v = toView(p);
          c.beginPath();
          c.arc(v.x, v.y, active ? 4 : 3, 0, Math.PI * 2);
          c.fill();
        });
      }
      const anchor = toView(m.points[0]);
      c.font = "10px ui-monospace, monospace";
      c.fillStyle = "rgba(12,14,16,.72)";
      const label = labelFor(m, frame?.scale ?? NO_SCALE);
      const w = c.measureText(label).width + 8;
      c.fillRect(anchor.x + 6, anchor.y - 16, w, 14);
      c.fillStyle = color;
      c.fillText(label, anchor.x + 10, anchor.y - 5);
      c.restore();
    }
  }, [
    frameData,
    frame,
    view,
    toView,
    selection,
    draft,
    tool,
    anglePts,
    selectedId,
    showOverlay,
    ready,
    scientificRecipe,
    phases,
    selectedPhaseId,
    phaseTraceVisible,
    traceScope,
  ]);

  /* ---------------- loupe ---------------- */

  useEffect(() => {
    const loupe = loupeRef.current;
    if (!loupe || !cursorView || !loupeOn || !frameData) return;
    const ctx = loupe.getContext("2d")!;
    loupe.width = LOUPE;
    loupe.height = LOUPE;
    const imagePoint = toImage(cursorView);
    const src = LOUPE / (loupeZoom * view.s);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, LOUPE, LOUPE);
    ctx.drawImage(frameData.img, imagePoint.x - src / 2, imagePoint.y - src / 2, src, src, 0, 0, LOUPE, LOUPE);
    ctx.strokeStyle = "rgba(255,224,102,.9)";
    ctx.beginPath();
    ctx.moveTo(LOUPE / 2, 0);
    ctx.lineTo(LOUPE / 2, LOUPE);
    ctx.moveTo(0, LOUPE / 2);
    ctx.lineTo(LOUPE, LOUPE / 2);
    ctx.stroke();
  }, [cursorView, loupeOn, loupeZoom, frameData, view.s, toImage, ready]);

  /* ---------------- histogram ---------------- */

  useEffect(() => {
    if (!frameData || !showHistogram) {
      setBins(null);
      return;
    }
    const roi =
      selection && (selection.type === "Rectangle" || selection.type === "Oval")
        ? rectFrom(selection.points)
        : undefined;
    setBins(channelHistogram(frameData.data, frameData.field, histChannel, roi));
  }, [frameData, showHistogram, selection, ready, histChannel]);

  function fitLimitsToSelection() {
    if (!frameData || selection?.type !== "Region") {
      setStatus("Trace a region with the Wand first, then fit the histogram limits to it.");
      return;
    }
    const limits = regionLimits(frameData.field, selection.seg.mask);
    if (!limits) {
      setStatus("The selected region is too small to derive limits.");
      return;
    }
    setDetect((d) => ({ ...d, channelLimits: limits }));
    setHistChannel((c) => (c === "gray" ? "L" : c));
    setStatus("Histogram limits set from the selected region. They apply to the wand and to phases you add.");
  }

  /* ---------------- helpers ---------------- */

  function updateFrame(index: number, patch: Partial<FrameState>) {
    setFrames((current) =>
      current.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );
  }

  function addMeasurement(index: number, m: Measurement) {
    setFrames((current) =>
      current.map((f, i) => (i === index ? { ...f, measurements: [...f.measurements, m] } : f)),
    );
  }

  function measureSelection(sel: Selection | null = selection) {
    if (!sel || !frame) return;
    const m = buildMeasurement(sel, frameData, detect);
    if (!m) return;
    addMeasurement(activeIndex, m);
    setStatus(`Measured ${m.label}. The ROI remains temporary until Draw is used.`);
  }

  function drawSelectionToImage() {
    if (!selection || !frame) {
      setStatus("Draw or select an ROI first.");
      return;
    }
    const mark = buildMeasurement(selection, frameData, detect);
    if (!mark) return;
    updateFrame(activeIndex, { drawings: [...(frame.drawings ?? []), mark] });
    setLastSelection(selection);
    setSelection(null);
    setSelectedId(mark.id);
    setStatus("Selection drawn permanently on this frame.");
  }

  function clearTemporarySelection() {
    if (selection) setLastSelection(selection);
    setSelection(null);
    setDraft(null);
    setAnglePts([]);
  }

  function restoreSelection() {
    if (!lastSelection) {
      setStatus("No previous selection to restore.");
      return;
    }
    setSelection(lastSelection);
    setStatus("Previous selection restored.");
  }

  function chooseTool(next: ToolId) {
    if (next !== tool) clearTemporarySelection();
    setTool(next);
  }

  /* ---------------- pointer handling ---------------- */

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): Pt {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * CW,
      y: ((event.clientY - rect.top) / rect.height) * CH,
    };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!hasImage || !frameData) return;
    const v = canvasPoint(event);
    const p = toImage(v);
    setContextMenu(null);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (tool === "hand") {
      panStart.current = { pointer: v, pan };
      return;
    }
    if (tool === "select") {
      const hit = [...(frame?.drawings ?? [])].reverse().find((m) => hitTest(m, p, 8 / view.s));
      setSelectedId(hit ? hit.id : null);
      if (!hit) clearTemporarySelection();
      setStatus(hit ? `Selected permanent ${hit.label}` : "Selection cleared");
      return;
    }
    if (tool === "point") {
      const sel: Selection = { type: "Point", points: [p] };
      setSelection(sel);
      if (autoMeasure) measureSelection(sel);
      return;
    }
    if (tool === "wand") {
      runWand(p);
      return;
    }
    if (tool === "angle") {
      const next = anglePts.length >= 3 ? [p] : [...anglePts, p];
      setAnglePts(next);
      if (next.length === 3) {
        const sel: Selection = { type: "Angle", points: next };
        setSelection(sel);
        if (autoMeasure) measureSelection(sel);
        setAnglePts([]);
      }
      return;
    }
    if (selection) setLastSelection(selection);
    setSelection(null);
    setDraft([p, p]);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!hasImage || !frameData) return;
    const v = canvasPoint(event);
    const p = toImage(v);
    setCursorView(v);

    const xi = Math.round(p.x);
    const yi = Math.round(p.y);
    if (xi >= 0 && yi >= 0 && xi < frameData.width && yi < frameData.height) {
      const o = (yi * frameData.width + xi) * 4;
      const rgb = {
        r: frameData.data.data[o],
        g: frameData.data.data[o + 1],
        b: frameData.data.data[o + 2],
      };
      setProbe({ x: xi, y: yi, rgb, lab: rgbToLab(rgb.r, rgb.g, rgb.b) });
    } else setProbe(null);

    if (panStart.current && tool === "hand") {
      setPan({
        x: panStart.current.pan.x + (v.x - panStart.current.pointer.x),
        y: panStart.current.pan.y + (v.y - panStart.current.pointer.y),
      });
      return;
    }
    const draftStart = draft?.[0];
    if (draftStart) setDraft([draftStart, p]);
  }

  function onPointerUp() {
    panStart.current = null;
    if (!draft) return;
    const [a, b] = draft;
    setDraft(null);
    if (!a || !b) return;
    if (dist(a, b) * view.s < 4) return;
    const type = tool === "rect" ? "Rectangle" : tool === "oval" ? "Oval" : "Line";
    const sel = { type, points: [a, b] } as Selection;
    setSelection(sel);
    if (autoMeasure) measureSelection(sel);
    if (type === "Line" && calibrationInstruction) {
      setStatus(`Reference line captured: ${fmt(dist(a, b), 1)} px. Review and set the scale.`);
      setCalibrationInstruction(null);
    }
  }

  function onCanvasContextMenu(event: ReactMouseEvent<HTMLCanvasElement>) {
    event.preventDefault();
    if (!frameData) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const viewPoint = {
      x: ((event.clientX - rect.left) / rect.width) * CW,
      y: ((event.clientY - rect.top) / rect.height) * CH,
    };
    const point = toImage(viewPoint);
    if (tool === "wand" && activeIndex === 0) {
      const roi = selection && (selection.type === "Rectangle" || selection.type === "Oval") ? rectFrom(selection.points) : undefined;
      const seg = detectRegion(frameData.field, point, detect, roi);
      if (!seg) {
        setStatus("No CIELAB region found at this point — adjust the detection tolerance.");
        return;
      }
      setSelection({ type: "Region", points: [seg.centroid], seg, deltaE: labDistance(seg.meanLab, seg.seedLab, detect.metric) });
      setContextMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, id: "__cielab__" });
      return;
    }
    const hit = [...(frame?.drawings ?? [])].reverse().find((item) => hitTest(item, point, 10 / view.s));
    if (!hit) {
      setContextMenu(null);
      return;
    }
    setSelectedId(hit.id);
    setContextMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, id: hit.id });
  }

  /* ---------------- CIELAB detection ---------------- */

  function runWand(seed: Pt) {
    if (!frameData) return;
    const roi =
      selection && (selection.type === "Rectangle" || selection.type === "Oval")
        ? rectFrom(selection.points)
        : undefined;
    const seg = detectRegion(frameData.field, seed, detect, roi);
    if (!seg) {
      setStatus("No region found — raise the ΔE tolerance.");
      return;
    }
    const delta = labDistance(seg.meanLab, seg.seedLab, detect.metric);
    const sel: Selection = { type: "Region", points: [seg.centroid], seg, deltaE: delta };
    setSelection(sel);
    setStatus(
      `Traced ${seg.areaPx} px² · perimeter ${fmt(seg.perimeterPx, 1)} px · circularity ${fmt(seg.circularity, 3)}`,
    );
    if (autoMeasure) measureSelection(sel);
  }

  /* ---------------- user-defined scientific phases ---------------- */

  function addPhase() {
    const id = newId();
    setPhases((current) => [
      ...current,
      { id, name: `Phase ${current.length + 1}`, role: current.some((p) => p.role === "target") ? "secondary" : "target", color: PHASE_TRACE_COLORS[current.length % PHASE_TRACE_COLORS.length] },
    ]);
    setSelectedPhaseId(id);
  }

  function renamePhase(id: string, name: string) {
    setPhases((current) => current.map((p) => (p.id === id ? { ...p, name } : p)));
    setScientificRecipe((current) => {
      if (!current) return current;
      const old = phases.find((p) => p.id === id);
      if (!old) return current;
      return { ...current, groups: current.groups.map((g) => (g.name === old.name ? { ...g, name: name.trim() || g.name } : g)) };
    });
  }

  function setPhaseRole(id: string, role: "target" | "secondary") {
    setPhases((current) => current.map((p) => (p.id === id ? { ...p, role } : p)));
    setScientificRecipe((current) => {
      if (!current) return current;
      const phase = phases.find((p) => p.id === id);
      if (!phase) return current;
      return { ...current, groups: current.groups.map((g) => (g.name === phase.name ? { ...g, role } : g)) };
    });
  }

  function removePhase(id: string) {
    if (phases.length <= 1) return;
    const removed = phases.find((p) => p.id === id);
    const next = phases.filter((p) => p.id !== id);
    setPhases(next);
    if (selectedPhaseId === id) setSelectedPhaseId(next[0].id);
    if (removed) {
      setScientificRecipe((current) =>
        current ? { ...current, groups: current.groups.filter((g) => g.name !== removed.name) } : current,
      );
    }
  }

  const PHASE_TRACE_COLORS = ["#ff4d6d", "#38bdf8", "#a78bfa", "#f59e0b", "#34d399", "#fb7185", "#22d3ee", "#facc15"];

  function phaseTraceColor(groupIndex: number) {
    return PHASE_TRACE_COLORS[groupIndex % PHASE_TRACE_COLORS.length];
  }

  function togglePhaseTrace(phaseId: string) {
    setPhaseTraceVisible((current) => ({ ...current, [phaseId]: !(current[phaseId] ?? true) }));
  }

  function updateScientificGroup(groupId: string, patch: Partial<NonNullable<ScientificRecipe>["groups"][number]>) {
    setScientificRecipe((current) => current ? { ...current, groups: current.groups.map((g) => g.id === groupId ? { ...g, ...patch } : g) } : current);
  }

  function addScientificComponentFromSegment(seg: SegmentResult) {
    const activePhase = phases.find((p) => p.id === selectedPhaseId) ?? phases[0];
    if (!frame || !frameData || activeIndex !== 0 || !activePhase) {
      setStatus("On reference frame 1, use Wand to trace one phase, then add that region to a scientific phase.");
      return;
    }
    const component = {
      id: newId(),
      label: activePhase.name.trim() || "Phase",
      referenceLab: seg.meanLab,
      referenceRgb: (() => { const x = Math.max(0, Math.min(frameData.width - 1, Math.round(seg.centroid.x))); const y = Math.max(0, Math.min(frameData.height - 1, Math.round(seg.centroid.y))); const o = (y * frameData.width + x) * 4; return { r: frameData.data.data[o], g: frameData.data.data[o + 1], b: frameData.data.data[o + 2] }; })(),
      pointsRel: [{ x: seg.centroid.x / frameData.width, y: seg.centroid.y / frameData.height }],
      contourRel: seg.contour.map((p) => ({ x: p.x / frameData.width, y: p.y / frameData.height })),
      detect: { ...detect },
      searchRadiusRel: searchRadius / Math.max(frameData.width, frameData.height),
    };
    setPhaseTraceVisible((current) => ({ ...current, [selectedPhaseId]: current[selectedPhaseId] ?? true }));
    setScientificRecipe((current) => {
      const base: ScientificRecipe = current ?? {
        groups: [],
        lines: [],
        interaction: { mode: "resolve-overlaps", ambiguityMargin: 1.5, spatialTieBreak: 0.08 },
        scale: { ...frame.scale },
        capturedFrom: frame.name,
        capturedAt: new Date().toLocaleString(),
      };
      const groups = [...base.groups];
      const existing = groups.find((g) => g.name.toLowerCase() === component.label.toLowerCase() && g.role === activePhase.role);
      if (existing) {
        existing.components = [...existing.components, component];
        existing.traceVisible = existing.traceVisible ?? true;
        existing.traceWidth = existing.traceWidth ?? 2.5;
        existing.traceDashed = existing.traceDashed ?? false;
        existing.traceColor = existing.traceColor ?? activePhase.color;
      } else {
        groups.push({ id: newId(), name: component.label, role: activePhase.role, components: [component], traceColor: activePhase.color, traceWidth: 2.5, traceDashed: false, traceVisible: true });
      }
      return { ...base, groups, scale: { ...frame.scale } };
    });
    setStatus(`Added traced ${activePhase.role} component to “${component.label}”. Add another component to build a composite phase.`);
    clearTemporarySelection();
  }

  function addScientificComponent() {
    if (selection?.type !== "Region") {
      setStatus("Use the Wand to trace a region first.");
      return;
    }
    addScientificComponentFromSegment(selection.seg);
  }

  function newBaseRecipe(frameRef: FrameState, current: ScientificRecipe | null): ScientificRecipe {
    return current ?? { groups: [], lines: [], angles: [], interaction: { mode: "resolve-overlaps", ambiguityMargin: 1.5, spatialTieBreak: 0.08 }, scale: { ...frameRef.scale }, capturedFrom: frameRef.name, capturedAt: new Date().toLocaleString() };
  }

  function uniqueLabel(wanted: string, existing: string[]) {
    if (!existing.includes(wanted)) return wanted;
    let n = 2;
    while (existing.includes(`${wanted} ${n}`)) n++;
    return `${wanted} ${n}`;
  }

  /** Save the selected line or angle on frame 1 as a named measurable quantity. */
  function applyQuantity() {
    const def = QTY[qtyKind];
    if (!frame || !frameData || activeIndex !== 0) {
      setStatus("Go to reference frame 1, draw the line or angle, then choose what it measures.");
      return;
    }
    const searchRel = searchRadius / Math.max(frameData.width, frameData.height);
    const rel = (p: Pt): Pt => ({ x: p.x / frameData.width, y: p.y / frameData.height });
    const wanted = qtyName.trim() || def.defaultName;
    if (def.shape === "angle") {
      if (!selectedAnglePoints || selectedAnglePoints.length < 3) {
        setStatus("Pick the Angle tool and click: end of arm 1 (e.g. along the surface), the vertex (contact point), then end of arm 2. Then press this button.");
        return;
      }
      const pts = selectedAnglePoints.slice(0, 3) as [Pt, Pt, Pt];
      setScientificRecipe((current) => {
        const base = newBaseRecipe(frame, current);
        const angles = base.angles ?? [];
        const angle: ScientificAngle = {
          id: newId(),
          label: uniqueLabel(wanted, angles.map((x) => x.label)),
          quantity: wanted,
          pRel: [rel(pts[0]), rel(pts[1]), rel(pts[2])],
          anchors: captureAngleAnchors(frameData.field, frameData.data, pts),
          searchRadiusRel: searchRel,
          lightnessWeight: detect.lightnessWeight ?? 1,
          rgbWeight: detect.rgbWeight ?? 0.2,
          useBoundaryTangent: qtyKind === "contact-angle",
          wedge: qtyKind === "contact-angle" ? captureWedge(frameData.field, pts, detect) : undefined,
        };
        return { ...base, angles: [...angles, angle], scale: { ...frame.scale } };
      });
      setStatus(def.done);
      return;
    }
    if (!selectedLinePoints) {
      setStatus("Draw a line (or click a saved line) first, then choose what it measures.");
      return;
    }
    const [a, b] = selectedLinePoints;
    const role = def.role!;
    setScientificRecipe((current) => {
      const base = newBaseRecipe(frame, current);
      const line: ScientificLine = {
        id: newId(),
        role,
        label: uniqueLabel(wanted, base.lines.map((l) => l.label)),
        quantity: wanted,
        p1Rel: rel(a),
        p2Rel: rel(b),
        searchRadiusRel: searchRel,
        lightnessWeight: detect.lightnessWeight ?? 1,
        rgbWeight: detect.rgbWeight ?? 0.2,
        anchors: role === "height" || role === "length" ? captureLineAnchors(frameData.field, frameData.data, a, b) : undefined,
      };
      // Base level and chord are single definitions; tracked lengths and axes may be several.
      const lines = role === "height" || role === "length" ? [...base.lines, line] : [...base.lines.filter((l) => l.role !== role), line];
      return { ...base, lines, scale: { ...frame.scale } };
    });
    setStatus(def.done);
  }

  /** On the LAST frame: place the selected line/angle as the end keyframe of an existing quantity. */
  function setEndKeyframe(kind: "line" | "angle", id: string) {
    const last = frames.length - 1;
    if (!frame || !frameData || last < 1 || activeIndex !== last) {
      setStatus("Open the last frame, draw the same line/angle there (same point order), select it, then press this button.");
      return;
    }
    const rel = (p: Pt): Pt => ({ x: p.x / frameData.width, y: p.y / frameData.height });
    if (kind === "line") {
      if (!selectedLinePoints) { setStatus("Draw or click a line on the last frame first."); return; }
      const [a, b] = selectedLinePoints;
      const endAnchors = captureLineAnchors(frameData.field, frameData.data, a, b);
      setScientificRecipe((cur) => cur ? { ...cur, lines: cur.lines.map((l) => l.id === id ? { ...l, endRel: [rel(a), rel(b)], endAnchors } : l) } : cur);
    } else {
      if (!selectedAnglePoints || selectedAnglePoints.length < 3) { setStatus("Draw or click an angle on the last frame first."); return; }
      const pts = selectedAnglePoints.slice(0, 3) as [Pt, Pt, Pt];
      const endAnchors = captureAngleAnchors(frameData.field, frameData.data, pts);
      setScientificRecipe((cur) => cur ? { ...cur, angles: (cur.angles ?? []).map((x) => x.id === id ? { ...x, endRel: [rel(pts[0]), rel(pts[1]), rel(pts[2])], endAnchors } : x) } : cur);
    }
    setStatus("Last-frame position saved. Frames in between are tracked between the first and last positions.");
  }

  function clearEndKeyframe(kind: "line" | "angle", id: string) {
    setScientificRecipe((cur) => !cur ? cur : kind === "line"
      ? { ...cur, lines: cur.lines.map((l) => l.id === id ? { ...l, endRel: undefined, endAnchors: undefined } : l) }
      : { ...cur, angles: (cur.angles ?? []).map((x) => x.id === id ? { ...x, endRel: undefined, endAnchors: undefined } : x) });
  }

  function removeScientificLine(id: string) {
    setScientificRecipe((current) => current ? { ...current, lines: current.lines.filter((l) => l.id !== id) } : current);
  }

  function removeScientificAngle(id: string) {
    setScientificRecipe((current) => current ? { ...current, angles: (current.angles ?? []).filter((x) => x.id !== id) } : current);
  }

  const runnableScientific = (() => {
    if (!scientificRecipe) return false;
    const hasTarget = scientificRecipe.groups.some((g) => g.role === "target");
    return scientificRecipe.lines.some((l) => l.role === "height" || l.role === "length") ||
      (scientificRecipe.angles?.length ?? 0) > 0 ||
      (hasTarget && scientificRecipe.lines.some((l) => l.role === "base" || l.role === "chord"));
  })();

  const runScientificFrameUnsafe = useCallback(async (index: number, recipe: ScientificRecipe, track?: ScientificTrack) => {
    const target = frames[index];
    const next: ScientificTrack = { seeds: new Map(), endpoints: new Map(), angles: new Map() };
    if (!target) return next;
    const loaded = await loadFrame(target);
    const bufferError = validateImageData(loaded.data);
    if (bufferError) throw new Error(`INVALID_FRAME: ${bufferError}`);
    next.illumRef = track?.illumRef ?? null;
    // Optional: shift this frame's CIELAB so its border colour matches the reference frame's.
    const data = next.illumRef ? { ...loaded, field: normalizeToReference(loaded.field, next.illumRef) } : loaded;
    const scale = target.scale.pxPerUnit ? target.scale : recipe.scale;
    const results = [] as NonNullable<FrameState["scientific"]>;
    let targetMask: { mask: Uint8Array; width: number; height: number } | null = null;
    // Position of this frame in the sequence (0 = first, 1 = last), used for last-frame keyframes.
    const tFrac = frames.length > 1 ? index / (frames.length - 1) : 0;
    // Phases are segmented only when the user defined a measurement that needs a phase.
    const needsPhase = recipe.groups.some((g) => g.components.length > 0);
    if (needsPhase) {
      const segmented = segmentScientificGroups(data.field, recipe.groups, track?.seeds, recipe.interaction);
      const tgt = segmented.found.find((f) => f.group.role === "target" && f.segment);
      if (tgt?.segment) targetMask = { mask: tgt.segment.mask, width: tgt.segment.width, height: tgt.segment.height };
      for (const found of segmented.found) {
        found.seeds.forEach((v, k) => next.seeds.set(k, v));
        if (!found.segment) {
          results.push({
            phase: found.group.name, role: found.group.role,
            heightPx: null, heightPhysical: null, contactDiameterPx: null, contactDiameterPhysical: null,
            topY: null, baselineY: null, componentCount: 0, confidence: 0, status: "MISSING_PHASE",
            interaction: segmented.interaction,
          });
          continue;
        }
        const measured = measureScientificPhase(found.segment, recipe, scale, found.group, found.componentCount);
        const interaction = segmented.interaction;
        const ambiguousFraction = interaction.ambiguousPixels / Math.max(1, found.segment.areaPx);
        const interactionStatus = ambiguousFraction >= 0.25
          ? "SEGMENTATION_FAILED"
          : ambiguousFraction >= 0.05
            ? "LOW_CONFIDENCE"
            : measured.status;
        const interactionConfidence = ambiguousFraction >= 0.25
          ? 0
          : Math.min(measured.confidence, Math.max(0, 1 - ambiguousFraction * 2));
        results.push({ ...measured, confidence: interactionConfidence, status: interactionStatus, interaction });
      }
      if (segmented.interaction.overlapPixels > 0) {
        const phaseText = segmented.interaction.competingPhases.length ? ` · competing: ${segmented.interaction.competingPhases.join(", ")}` : "";
        setStatus(`Resolved ${segmented.interaction.resolvedPixels} interacting CIELAB pixels (${segmented.interaction.overlapPixels} overlaps, ${segmented.interaction.ambiguousPixels} close matches)${phaseText}.`);
      }
    }
    const lineResults = [] as NonNullable<FrameState["scientificLines"]>;
    for (const line of recipe.lines.filter((l) => l.role === "height" || l.role === "length")) {
      const tracked = trackHeightLine(data.field, line, scale, track?.endpoints.get(line.id), tFrac);
      if (tracked.endpoints) next.endpoints.set(line.id, tracked.endpoints);
      lineResults.push(tracked.result);
    }
    const angleResults = [] as NonNullable<FrameState["scientificAngles"]>;
    for (const angle of recipe.angles ?? []) {
      const tracked = trackAngle(data.field, angle, track?.angles?.get(angle.id), tFrac, targetMask);
      if (tracked.points) next.angles!.set(angle.id, tracked.points);
      angleResults.push(tracked.result);
    }
    const valid = results.filter((r) => r.status === "VALID").length + lineResults.filter((r) => r.status === "VALID").length + angleResults.filter((r) => r.status === "VALID").length;
    setFrames((current) => current.map((f, i) => i === index ? {
      ...f,
      scale: f.scale.pxPerUnit ? f.scale : { ...recipe.scale, origin: "inherited", note: `scientific inherited · ${recipe.scale.note}` },
      scientific: results,
      scientificLines: lineResults,
      scientificAngles: angleResults,
      analyzed: true,
      autoNote: `${valid}/${results.length + lineResults.length + angleResults.length} scientific measurement(s) valid`,
    } : f));
    next.lastStatus = "VALID";
    return next;
  }, [frames, loadFrame]);

  const runScientificFrame = useCallback(async (index: number, recipe: ScientificRecipe, track?: ScientificTrack) => {
    try {
      return await runScientificFrameUnsafe(index, recipe, track);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const invalid = message.startsWith("INVALID_FRAME:");
      const status: "INVALID_FRAME" | "SEGMENTATION_FAILED" = invalid ? "INVALID_FRAME" : "SEGMENTATION_FAILED";
      const failedResults = recipe.groups
        .filter((g) => g.components.length > 0)
        .map((g) => ({
          phase: g.name, role: g.role, heightPx: null, heightPhysical: null,
          contactDiameterPx: null, contactDiameterPhysical: null, topY: null, bottomY: null,
          pixelHeight: null, baselineY: null, componentCount: 0, confidence: 0, status,
        }));
      setFrames((current) => current.map((f, i) => i === index ? {
        ...f, scientific: failedResults, scientificLines: [], scientificAngles: [], analyzed: true,
        autoNote: `${status}: ${message}`,
      } : f));
      return { seeds: new Map<string, Pt>(), endpoints: new Map<string, [Pt, Pt]>(), angles: new Map<string, [Pt, Pt, Pt]>(), lastStatus: status };
    }
  }, [frames, runScientificFrameUnsafe]);

  async function runScientificAll() {
    if (!scientificRecipe || isRunningAll || !runnableScientific) return;
    setIsRunningAll(true);
    let track: ScientificTrack = { seeds: new Map(), endpoints: new Map(), illumRef: null };
    try {
      if (matchIllumination && frames[0]) track.illumRef = borderStats((await loadFrame(frames[0])).field);
      const outcomes = await executeBatchSequence(
        frames,
        async (_item, i) => {
          setStatus(`Scientific measurement ${i + 1}/${frames.length}: ${frames[i]?.name ?? "frame"}…`);
          track = await runScientificFrame(i, scientificRecipe, track);
          return true;
        },
        {
          onProgress: (i, total, item) => setStatus(`Scientific measurement ${i + 1}/${total}: ${item.name}…`),
          yieldEvery: 1,
          classifyError: (error) => String(error).startsWith("INVALID_FRAME:") ? "INVALID_FRAME" : "SEGMENTATION_FAILED",
          classifyValue: (value) => value.lastStatus ?? "VALID",
        },
      );
      const failed = outcomes.filter((o) => o.status !== "VALID");
      setReady((n) => n + 1);
      setStatus(failed.length
        ? `Scientific measurement completed with ${failed.length} frame(s) needing review.`
        : "Scientific measurement completed for the sequence.");
    } finally {
      setIsRunningAll(false);
    }
  }

  function captureRecipe() {
    if (!frame || !frameData || activeIndex !== 0) {
      setStatus("Capture the workflow from reference image 1.");
      return;
    }
    const measured = frame.measurements.filter((measurement) => measurement.source === "manual");
    const activeMeasurement = selection ? buildMeasurement(selection, frameData, detect) : null;
    const source = measured.length ? measured : activeMeasurement ? [activeMeasurement] : [];
    if (!source.length && !scientificRecipe?.groups.length && !scientificRecipe?.lines.length) {
      setStatus("Define at least one measurement or scientific phase/line on reference image 1, then capture.");
      return;
    }
    const steps: RecipeStep[] = source.map((measurement) => ({
      label: measurement.label,
      type: measurement.type,
      pointsRel: measurement.points.map((point) => ({
        x: point.x / frameData.width,
        y: point.y / frameData.height,
      })),
      referenceLab: measurement.meanLab,
      detect: measurement.type === "Region" ? { ...detect } : undefined,
      searchRadiusRel:
        measurement.type === "Region" || measurement.type === "Point"
          ? searchRadius / Math.max(frameData.width, frameData.height)
          : undefined,
    }));
    setRecipe({
      steps,
      scale: { ...frame.scale },
      inheritScale: true,
      capturedFrom: frame.name,
      capturedAt: new Date().toLocaleString(),
      scientific: scientificRecipe ? structuredClone(scientificRecipe) : undefined,
    });
    const scientificParts = scientificRecipe ? ` · ${scientificRecipe.groups.length} phase group(s), ${scientificRecipe.groups.reduce((n, g) => n + g.components.length, 0)} CIELAB region(s), ${scientificRecipe.lines.length} line definition(s), ${scientificRecipe.angles?.length ?? 0} angle definition(s)` : "";
    setStatus(`${steps.length}-step workflow${scientificParts} captured from ${frame.name}.`);
  }

  const runAuto = useCallback(
    async (index: number, activeRecipe: Recipe, priorAnchors?: Map<number, Pt>) => {
      const target = frames[index];
      if (!target || index === 0) return new Map<number, Pt>();
      const data = await loadFrame(target);
      const bufferError = validateImageData(data.data);
      if (bufferError) throw new Error(`INVALID_FRAME: ${bufferError}`);
      const nextAnchors = new Map<number, Pt>();
      const results: Measurement[] = [];
      const failures: string[] = [];
      const notes: string[] = [];

      for (let stepIndex = 0; stepIndex < activeRecipe.steps.length; stepIndex++) {
        const step = activeRecipe.steps[stepIndex];
        const points = step.pointsRel.map((point) => ({ x: point.x * data.width, y: point.y * data.height }));
        if (!points.length) continue;

        if (step.type === "Region" && step.referenceLab && step.detect) {
          const referencePoint = { x: step.pointsRel[0].x * data.width, y: step.pointsRel[0].y * data.height };
          const priorRel = priorAnchors?.get(stepIndex);
          const priorPoint = priorRel ? { x: priorRel.x * data.width, y: priorRel.y * data.height } : undefined;
          const baseRadius = Math.max(4, Math.round((step.searchRadiusRel ?? 0.05) * Math.max(data.width, data.height)));
          let relocated = relocateSeedWithSoftPrior(data.field, step.referenceLab, referencePoint, priorPoint, baseRadius, step.detect.metric, step.detect.lightnessWeight ?? 1, undefined, step.detect.rgbWeight ?? 0);
          let seg = detectRegion(data.field, relocated.seed, step.detect);
          if (!seg) {
            relocated = relocateSeedWithSoftPrior(data.field, step.referenceLab, referencePoint, priorPoint, baseRadius * 2, step.detect.metric, step.detect.lightnessWeight ?? 1, undefined, step.detect.rgbWeight ?? 0);
            seg = detectRegion(data.field, relocated.seed, step.detect);
          }
          if (!seg) {
            failures.push(step.label);
            continue;
          }
          results.push(measurementFromSegment(seg, `${step.label} (auto)`, labDistance(seg.meanLab, step.referenceLab, step.detect.metric), "auto"));
          nextAnchors.set(stepIndex, { x: seg.centroid.x / data.width, y: seg.centroid.y / data.height });
          notes.push(`${step.label}: ΔE ${fmt(relocated.delta, 2)}`);
          continue;
        }

        if (step.type === "Point" && step.referenceLab) {
          const referencePoint = { x: step.pointsRel[0].x * data.width, y: step.pointsRel[0].y * data.height };
          const priorRel = priorAnchors?.get(stepIndex);
          const priorPoint = priorRel ? { x: priorRel.x * data.width, y: priorRel.y * data.height } : undefined;
          const radius = Math.max(4, Math.round((step.searchRadiusRel ?? 0.05) * Math.max(data.width, data.height)));
          const relocated = relocateSeedWithSoftPrior(data.field, step.referenceLab, referencePoint, priorPoint, radius, "ciede2000");
          points[0] = relocated.seed;
          nextAnchors.set(stepIndex, { x: relocated.seed.x / data.width, y: relocated.seed.y / data.height });
        }

        const replaySelection = { type: step.type, points } as Selection;
        const replayed = buildMeasurement(replaySelection, data, detect);
        if (replayed) results.push({ ...replayed, label: `${step.label} (auto)`, source: "auto" });
      }

      setFrames((current) =>
        current.map((f, i) =>
          i === index
            ? {
                ...f,
                mode: "auto",
                analyzed: true,
                autoNote: failures.length
                  ? `${results.length}/${activeRecipe.steps.length} steps · manual review: ${failures.join(", ")}`
                  : `${results.length}/${activeRecipe.steps.length} steps reconstructed${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
                scale:
                  activeRecipe.inheritScale && activeRecipe.scale.pxPerUnit
                    ? { ...activeRecipe.scale, origin: "inherited", note: `inherited · ${activeRecipe.scale.note}` }
                    : f.scale,
                measurements: [...f.measurements.filter((x) => x.source !== "auto"), ...results],
              }
            : f,
        ),
      );
      return nextAnchors;
    },
    [frames, loadFrame],
  );

  async function runAll() {
    if (!recipe || isRunningAll) return;
    setIsRunningAll(true);
    let anchors = new Map<number, Pt>();
    let completed = 0;
    const failed: string[] = [];
    try {
      for (let i = 1; i < frames.length; i++) {
        setStatus(`Running recipe ${i}/${frames.length - 1}: ${frames[i]?.name ?? "frame"}…`);
        try {
          anchors = await runAuto(i, recipe, anchors);
          completed++;
        } catch {
          failed.push(frames[i]?.name ?? `Frame ${i + 1}`);
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (recipe.scientific?.groups.some((g) => g.components.length)) {
        let scientificTrack: ScientificTrack = { seeds: new Map(), endpoints: new Map(), illumRef: null };
        if (matchIllumination && frames[0]) scientificTrack.illumRef = borderStats((await loadFrame(frames[0])).field);
        for (let i = 0; i < frames.length; i++) {
          setStatus(`Running scientific recipe ${i + 1}/${frames.length}: ${frames[i]?.name ?? "frame"}…`);
          scientificTrack = await runScientificFrame(i, recipe.scientific, scientificTrack);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
      setReady((n) => n + 1);
      setStatus(failed.length ? `Recipe completed on ${completed} frame(s); ${failed.length} need review.` : `Recipe applied to ${completed} frame(s).`);
    } finally {
      setIsRunningAll(false);
    }
  }

  /* ---------------- PIV / image velocimetry ---------------- */

  async function runPivAll() {
    if (isRunningPiv || frames.length < 2) {
      if (frames.length < 2) setStatus("Load at least two images for PIV.");
      return;
    }
    setIsRunningPiv(true);
    setPivResults([]);
    try {
      const results: PivPairResult[] = [];
      const stride = Math.max(1, Math.round(pivConfig.frameStride));
      for (let i = 0; i + stride < frames.length; i += stride) {
        const j = i + stride;
        setStatus(`PIV ${i + 1} → ${j + 1} (${i + 1}/${Math.max(1, Math.floor((frames.length - 1) / stride))})…`);
        const a = await loadFrame(frames[i]);
        const b = await loadFrame(frames[j]);
        const activeRoi = selection?.type === "Rectangle" ? rectFrom(selection.points) : pivConfig.roi;
        const result = computePivPair(a.data, b.data, { ...pivConfig, roi: activeRoi }, i, j, frames[i].scale);
        results.push(result);
        setPivResults([...results]);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      setStatus(`PIV complete: ${results.length} frame pair(s), ${results.reduce((n, r) => n + r.validCount, 0)} valid vectors.`);
      setReady((n) => n + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "PIV failed.");
    } finally {
      setIsRunningPiv(false);
    }
  }

  function clearPiv() {
    setPivResults([]);
    setStatus("PIV results cleared.");
  }

  /* ---------------- files & export ---------------- */

  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const added: FrameState[] = files.map((file) => ({
      id: newId(),
      name: file.name,
      url: URL.createObjectURL(file),
      sizeLabel: formatSize(file.size),
      mode: "manual",
      scale: { ...NO_SCALE },
      measurements: [],
      drawings: [],
      analyzed: false,
      autoNote: "",
    }));
    const wasEmpty = frames.length === 0;
    if (wasEmpty) {
      setActiveIndex(0);
      setZoom(100);
      setPan({ x: 0, y: 0 });
      clearTemporarySelection();
      const firstAdded = added[0];
      if (firstAdded) void loadFrame(firstAdded).then(() => setReady((n) => n + 1));
    }
    setFrames((current) => [...current, ...added]);
    void storeImages(files.map((file, index) => ({ id: added[index]?.id ?? newId(), name: file.name, size: file.size, blob: file })))
      .catch(() => setStatus("Images loaded, but recovery storage is unavailable."));
    event.target.value = "";
    setStatus(`${added.length} image(s) added.${wasEmpty ? " Showing the first image." : ""}`);
  }

  useEffect(() => {
    let cancelled = false;
    restoreImages()
      .then((stored) => {
        if (cancelled || frames.length || !stored.length) return;
        const restored: FrameState[] = stored.map((item) => ({
          id: item.id,
          name: item.name,
          url: URL.createObjectURL(item.blob),
          sizeLabel: formatSize(item.size),
          mode: "manual",
          scale: { ...NO_SCALE },
          measurements: [],
          drawings: [],
          analyzed: false,
          autoNote: "Recovered after refresh",
        }));
        setFrames(restored);
        setStatus(`${restored.length} uploaded image(s) recovered.`);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const calibrationPx = useMemo(() => {
    if (selection?.type === "Line") {
      const [a, b] = selection.points;
      return a && b ? dist(a, b) : null;
    }
    const lines = (frame?.measurements ?? []).filter((m) => m.type === "Line");
    return lines.at(-1)?.lengthPx ?? null;
  }, [selection, frame]);

  /** Setups captured on frame 1 are frame-specific, so they are dropped when the reference frame changes. */
  function dropReferenceSetups() {
    const had = Boolean(scientificRecipe || recipe);
    setScientificRecipe(null);
    setRecipe(null);
    return had;
  }

  function removeFrameById(id: string) {
    const idx = frames.findIndex((f) => f.id === id);
    setFrameMenu(null);
    if (idx < 0) return;
    const doomed = frames[idx];
    cacheRef.current.delete(doomed.id);
    URL.revokeObjectURL(doomed.url);
    void removeStoredImage(doomed.id);
    setFrames((c) => c.filter((f) => f.id !== id));
    setActiveIndex((a) => (idx < a ? a - 1 : idx === a ? Math.max(0, Math.min(a, frames.length - 2)) : a));
    clearTemporarySelection();
    setSelectedId(null);
    const cleared = idx === 0 && frames.length > 1 ? dropReferenceSetups() : false;
    setStatus(`Deleted ${doomed.name}.${cleared ? " The reference frame changed, so phase/line setups were cleared — set them up again on the new frame 1." : ""}`);
  }

  function setFrameAsReference(id: string) {
    const idx = frames.findIndex((f) => f.id === id);
    setFrameMenu(null);
    if (idx <= 0) return;
    const moving = frames[idx];
    setFrames((c) => [{ ...c[idx], mode: "manual" }, ...c.filter((f) => f.id !== id)]);
    setActiveIndex(0);
    setZoom(100);
    setPan({ x: 0, y: 0 });
    clearTemporarySelection();
    setSelectedId(null);
    const cleared = dropReferenceSetups();
    setStatus(`${moving.name} is now the reference (frame 1).${cleared ? " Earlier phase/line setups were cleared because they belonged to the old reference." : ""}`);
  }

  function closeFrames(all: boolean) {
    if (!frames.length) return;
    if (!all) {
      if (frame) removeFrameById(frame.id);
      return;
    }
    for (const f of frames) {
      cacheRef.current.delete(f.id);
      URL.revokeObjectURL(f.url);
      void removeStoredImage(f.id);
    }
    setFrames([]);
    setActiveIndex(0);
    clearTemporarySelection();
    setSelectedId(null);
    setScientificRecipe(null);
    setRecipe(null);
    setStatus("All frames closed.");
  }

  const clearScientificResults = () =>
    setFrames((c) => c.map((f) => ({ ...f, scientific: undefined, scientificLines: undefined, scientificAngles: undefined })));

  const goToFrame = (delta: number) =>
    setActiveIndex((i) => Math.max(0, Math.min(frames.length - 1, i + delta)));

  /*
   * Menu map
   *  File     — bring data in / take results out / close images
   *  Edit     — selections, saved marks, clearing results and setups
   *  View     — how the image is shown (zoom, overlay, magnifier, frame stepping)
   *  Analyze  — measure and tune detection on the current frame
   *  Batch    — replay what was set up on frame 1 across the whole sequence
   */
  const menu = {
    File: [
      { label: "Open images…", action: () => document.getElementById("pm-file")?.click() },
      { label: "Export results (CSV)", action: () => download("pixmatch-results.csv", exportCsv(frames), "text/csv") },
      { label: "Export report (HTML)", action: () => download("pixmatch-report.html", exportHtml(frames, recipe), "text/html") },
      { label: "Close frame", action: () => closeFrames(false) },
      { label: "Close all frames", action: () => closeFrames(true) },
    ],
    Edit: [
      { label: "Draw selection", action: drawSelectionToImage },
      { label: "Restore selection", action: restoreSelection },
      { label: "Select none", action: () => { clearTemporarySelection(); setSelectedId(null); } },
      {
        label: "Delete permanent drawing",
        action: () => {
          if (!selectedId) return;
          updateFrame(activeIndex, { drawings: (frame?.drawings ?? []).filter((m) => m.id !== selectedId) });
          setSelectedId(null);
        },
      },
      { label: "Clear results (frame)", action: () => updateFrame(activeIndex, { measurements: [], scientific: undefined, scientificLines: undefined, scientificAngles: undefined }) },
      {
        label: "Clear results (all frames)",
        action: () => setFrames((c) => c.map((f) => ({ ...f, measurements: [], scientific: undefined, scientificLines: undefined, scientificAngles: undefined, analyzed: false, autoNote: "" }))),
      },
      { label: "Clear scientific setup (phases + lines)", action: () => { setScientificRecipe(null); setStatus("Scientific setup cleared."); } },
    ],
    View: [
      { label: "Previous frame", action: () => goToFrame(-1) },
      { label: "Next frame", action: () => goToFrame(1) },
      { label: "Zoom in", action: () => setZoom((z) => Math.min(6400, z * 1.5)) },
      { label: "Zoom out", action: () => setZoom((z) => Math.max(10, z / 1.5)) },
      { label: "Fit to window", action: () => { setZoom(100); setPan({ x: 0, y: 0 }); } },
      { label: "Actual size (100%)", action: () => { if (!frameData) return; const fit = Math.min(CW / frameData.width, CH / frameData.height); setZoom(100 / fit); setPan({ x: 0, y: 0 }); } },
      { label: showOverlay ? "Hide overlay" : "Show overlay", action: () => setShowOverlay((v) => !v) },
      { label: loupeOn ? "Hide magnifier" : "Show magnifier", action: () => setLoupeOn((v) => !v) },
    ],
    Analyze: [
      { label: "Measure selection", action: () => measureSelection() },
      { label: "Fit histogram limits to selected region", action: fitLimitsToSelection },
      { label: "Clear histogram limits", action: () => setDetect((d) => ({ ...d, channelLimits: null })) },
      { label: showHistogram ? "Hide histogram" : "Show histogram", action: () => setShowHistogram((v) => !v) },
      { label: autoMeasure ? "Auto-measure: on" : "Auto-measure: off", action: () => setAutoMeasure((v) => !v) },
      { label: "Run PIV / image velocimetry", action: () => { void runPivAll(); } },
      { label: "Export PIV vectors (CSV)", action: () => download("pixmatch-piv.csv", exportPivCsv(pivResults), "text/csv") },
      { label: "Clear PIV vectors", action: clearPiv },
    ],
    Batch: [
      { label: "Run scientific measurement on all frames", action: () => { void runScientificAll(); } },
      { label: "Clear scientific results", action: clearScientificResults },
      { label: "Capture recipe from this frame", action: captureRecipe },
      { label: "Run recipe on this frame", action: () => recipe && runAuto(activeIndex, recipe).then(() => setReady((n) => n + 1)) },
      { label: "Run recipe on all frames", action: runAll },
      { label: "Set this frame to manual", action: () => updateFrame(activeIndex, { mode: "manual" }) },
    ],
  } satisfies Record<string, { label: string; action: () => void }[]>;

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        const target = event.target as HTMLElement;
        if (target?.tagName?.match(/INPUT|SELECT|TEXTAREA/)) return;
        event.preventDefault();
        undoLastAction();
        return;
      }
      if ((event.target as HTMLElement)?.tagName?.match(/INPUT|SELECT|TEXTAREA/)) return;
      const map: Record<string, ToolId> = {
        v: "select", l: "line", a: "angle", r: "rect", o: "oval", p: "point", w: "wand", h: "hand",
      };
       if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
         event.preventDefault();
         drawSelectionToImage();
         return;
       }
       if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "e") {
         event.preventDefault();
         restoreSelection();
         return;
       }
       if (event.key === "Escape") {
         setOpenMenu(null);
         setFrameMenu(null);
         clearTemporarySelection();
         setSelectedId(null);
         setStatus("Selection cleared.");
         return;
       }
       const shortcutTool = map[event.key.toLowerCase()];
       if (shortcutTool) chooseTool(shortcutTool);
      if (event.key.toLowerCase() === "m") measureSelection();
      if (event.key === "Delete" || event.key === "Backspace") {
        if (!selectedId) return;
        updateFrame(activeIndex, {
          drawings: (frame?.drawings ?? []).filter((m) => m.id !== selectedId),
        });
        setSelectedId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const activeTool = TOOLS.find((t) => t.id === tool);
  const loupeStyle = cursorView
    ? {
        left: `${(cursorView.x / CW) * 100}%`,
        top: `${(cursorView.y / CH) * 100}%`,
        transform: `translate(${cursorView.x > CW * 0.7 ? "-110%" : "14%"}, ${cursorView.y > CH * 0.55 ? "-110%" : "14%"})`,
      }
    : { left: 0, top: 0 };

  return (
    <div className="min-h-screen bg-background text-foreground" onClick={(event) => { setOpenMenu(null); setContextMenu(null); setFrameMenu(null); const target = event.target as HTMLElement; if (!target.closest("canvas, button, input, select, [data-keep-selection]")) clearTemporarySelection(); }}>
      <input id="pm-file" type="file" multiple accept="image/*,.tif,.tiff,.bmp" className="hidden" onChange={onFiles} />

      {/* Menu bar */}
      <header className="app-menubar flex items-center gap-1 px-3 py-2">
        <div className="mr-3 flex items-center gap-2">
          <span className="brand-mark"><Aperture size={16} /></span>
          <span className="flex flex-col leading-none">
            <span className="brand-name">PixMatch</span>
            <span className="brand-subtitle mt-1">Image analysis workspace</span>
          </span>
        </div>
        {Object.entries(menu).map(([name, items]) => (
          <div key={name} className="relative">
            <button
              className="ij-btn"
              data-active={openMenu === name}
              onClick={(e) => {
                e.stopPropagation();
                setFrameMenu(null);
                const r = e.currentTarget.getBoundingClientRect();
                setMenuPos({ left: r.left, top: r.bottom + 6 });
                setOpenMenu(openMenu === name ? null : name);
              }}
            >
              {name}
            </button>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className="ij-num text-muted-foreground">
            {frames.length} frame(s) · {frame ? frame.mode : "—"}
          </span>
          <div className="relative" data-keep-selection>
            <button
              className="pix-download-btn"
              title="Download PixMatch results in multiple formats"
              aria-haspopup="menu"
              aria-expanded={downloadMenuOpen}
              onClick={() => setDownloadMenuOpen((v) => !v)}
            >
              <Download size={13} className="mr-1 inline" />
              Download <span className="ml-1 text-[10px]">▾</span>
            </button>
            {downloadMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-[80] w-64 rounded-lg border border-blue-400/30 bg-[#07111f]/98 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,.55),0_0_18px_rgba(45,145,255,.22)] backdrop-blur" role="menu">
                <div className="px-2 py-1 text-[9px] uppercase tracking-widest text-slate-400">Export current analysis</div>
                <button className="download-menu-item" onClick={() => { download("pixmatch-results.csv", exportCsv(frames), "text/csv;charset=utf-8"); setDownloadMenuOpen(false); }}>CSV results</button>
                <button className="download-menu-item" onClick={() => { download("pixmatch-results.xls", exportExcel(frames), "application/vnd.ms-excel;charset=utf-8"); setDownloadMenuOpen(false); }}>Excel sheet (.xls)</button>
                <button className="download-menu-item" onClick={async () => { try { const blob = await exportGraphPng(frames); download("pixmatch-scientific-graph.png", blob, "image/png"); } finally { setDownloadMenuOpen(false); } }}>Graph PNG</button>
                <button className="download-menu-item" onClick={() => { download("pixmatch-report.pdf", exportPdf(frames, recipe), "application/pdf"); setDownloadMenuOpen(false); }}>PDF report</button>
                <button className="download-menu-item" onClick={() => { download("pixmatch-report.html", exportHtml(frames, recipe), "text/html;charset=utf-8"); setDownloadMenuOpen(false); }}>HTML report</button>
                <button className="download-menu-item" disabled={!pivResults.length} onClick={() => { download("pixmatch-piv.csv", exportPivCsv(pivResults), "text/csv;charset=utf-8"); setDownloadMenuOpen(false); }}>PIV vectors CSV{pivResults.length ? "" : " · no data"}</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Dropdowns live outside the header: its overflow-x + backdrop-filter would clip/contain them. */}
      {openMenu && (
        <div
          className="ij-raised fixed z-50 min-w-[230px] p-1.5 shadow-lg"
          style={{ left: Math.max(4, Math.min(menuPos.left, window.innerWidth - 250)), top: menuPos.top }}
          onClick={(event) => event.stopPropagation()}
        >
          {(menu[openMenu as keyof typeof menu] ?? []).map((item) => (
            <div
              key={item.label}
              className="ij-menu-item"
              onClick={() => {
                item.action();
                setOpenMenu(null);
              }}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}

      {/* Right-click menu for uploaded images */}
      {frameMenu && (() => {
        const idx = frames.findIndex((f) => f.id === frameMenu.id);
        if (idx < 0) return null;
        return (
          <div
            className="drawing-context-menu"
            style={{ position: "fixed", left: Math.min(frameMenu.x, window.innerWidth - 230), top: Math.min(frameMenu.y, window.innerHeight - 140), zIndex: 60 }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="context-title">{frames[idx].name}</div>
            <button disabled={idx === 0} onClick={() => setFrameAsReference(frameMenu.id)}>
              {idx === 0 ? "Already the reference" : "Set as reference (frame 1)"}
            </button>
            <button className="context-delete" onClick={() => removeFrameById(frameMenu.id)}>Delete image</button>
          </div>
        );
      })()}

      <main className="workspace-grid p-3">
        {/* Left: sequence */}
        <aside className="workspace-panel sequence-panel p-3">
          <div className="ij-title mb-1">Sequence</div>
          <button className="ij-btn mb-2 w-full" onClick={() => document.getElementById("pm-file")?.click()}>
            Open images…
          </button>
          <div className="ij-sunken max-h-[430px] space-y-px overflow-auto p-1">
            {frames.length === 0 ? (
              <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">
                No images loaded.
              </p>
            ) : (
              frames.map((f, i) => (
                <button
                  key={f.id}
                  className="frame-row flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors data-[on=true]:border-primary/40 data-[on=true]:bg-primary/15 data-[on=true]:text-foreground"
                  data-on={i === activeIndex}
                  title="Right-click: set as reference / delete"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpenMenu(null);
                    setContextMenu(null);
                    setFrameMenu({ x: event.clientX, y: event.clientY, id: f.id });
                  }}
                  onClick={() => {
                    setActiveIndex(i);
                     clearTemporarySelection();
                    setSelectedId(null);
                     setZoom(100);
                     setPan({ x: 0, y: 0 });
                  }}
                >
                  <span
                    className="h-8 w-8 shrink-0 border border-border bg-canvas bg-cover bg-center"
                    style={{ backgroundImage: `url(${f.url})` }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px]">{f.name}</span>
                    <span className="ij-num block text-[9px] opacity-80">
                      {i === 0 ? "REFERENCE · MANUAL" : f.mode.toUpperCase()} · {f.measurements.length} obj
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          {frame && (
            <div className="ij-sunken mt-2 space-y-1 p-2">
              <Kv k="Mode" v={frame.mode + (frame.analyzed ? " · analyzed" : "")} />
              <Kv
                k="Scale"
                v={frame.scale.pxPerUnit ? `${fmt(frame.scale.pxPerUnit, 2)} px/${frame.scale.unit}` : "uncalibrated"}
              />
              <Kv k="Size" v={frameData ? `${frameData.width}×${frameData.height}` : frame.sizeLabel} />
            </div>
          )}
        </aside>

        {/* Center: toolbar + canvas */}
        <section className="workspace-panel min-w-0 p-3">
          <div className="tool-strip mb-3 flex flex-wrap items-center gap-1.5">
            {TOOLS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className="ij-tool"
                data-active={tool === id}
                title={label}
                onClick={() => chooseTool(id)}
              >
                <Icon size={14} />
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-border" />
            <button className="ij-btn" title="Draw selection permanently (Ctrl+B)" onClick={drawSelectionToImage} disabled={!selection}>
              <Pencil size={12} className="mr-1 inline" /> Draw
            </button>
            <button className="ij-btn" title="Restore previous selection" onClick={restoreSelection} disabled={!lastSelection}>
              <RotateCcw size={12} />
            </button>
            <span className="mx-1 h-5 w-px bg-border" />
            <button className="ij-btn" onClick={() => setZoom((z) => Math.max(10, z / 1.5))}>
              <ZoomOut size={12} />
            </button>
            <span className="ij-num w-[54px] text-center">{Math.round(zoom)}%</span>
            <button className="ij-btn" onClick={() => setZoom((z) => Math.min(6400, z * 1.5))}>
              <ZoomIn size={12} />
            </button>
            <button className="ij-btn" onClick={() => { setZoom(100); setPan({ x: 0, y: 0 }); }}>
              <Move size={12} className="mr-1 inline" />
              Fit
            </button>
            <span className="mx-1 h-5 w-px bg-border" />
            <button className="ij-btn" data-active={loupeOn} onClick={() => setLoupeOn((v) => !v)}>
              Loupe {loupeZoom}×
            </button>
            <button className="ij-btn" onClick={() => setLoupeZoom((z) => (z >= 32 ? 2 : z + 2))}>
              +
            </button>
            <button className="ij-btn" onClick={() => measureSelection()} disabled={!selection}>
              Measure (M)
            </button>
          </div>

          {/* Status / probe bar, ImageJ style */}
          <div className="ij-sunken probe-strip mb-3 flex flex-wrap items-center gap-4 px-3 py-2">
            <span className="ij-num">
              x={probe ? probe.x : "—"} y={probe ? probe.y : "—"}
            </span>
            <span className="ij-num">
              value={probe ? Math.round(grayValue(probe.rgb.r, probe.rgb.g, probe.rgb.b)) : "—"}
            </span>
            <span className="ij-num flex items-center gap-1">
              RGB=
              {probe ? `${probe.rgb.r},${probe.rgb.g},${probe.rgb.b}` : "—"}
              {probe && (
                <span
                  className="inline-block h-3 w-3 border border-border"
                  style={{ background: rgbToHex(probe.rgb.r, probe.rgb.g, probe.rgb.b) }}
                />
              )}
            </span>
            <span className="ij-num">
              L*a*b*=
              {probe ? `${fmt(probe.lab.L, 1)}, ${fmt(probe.lab.a, 1)}, ${fmt(probe.lab.b, 1)}` : "—"}
            </span>
            {recipe && probe && recipe.steps.find((step) => step.referenceLab)?.referenceLab && (
              <span className="ij-num">
                ΔE to recipe={fmt(labDistance(probe.lab, recipe.steps.find((step) => step.referenceLab)?.referenceLab as LAB, detect.metric), 2)}
              </span>
            )}
          </div>

          <div className="canvas-stage relative overflow-hidden" data-keep-selection>
            <canvas
              ref={canvasRef}
              className="block w-full touch-none border border-border"
              style={{
                aspectRatio: `${CW} / ${CH}`,
                cursor: tool === "hand" ? "grab" : tool === "select" ? "default" : "crosshair",
              }}
              onContextMenu={onCanvasContextMenu}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => {
                setCursorView(null);
                setProbe(null);
                panStart.current = null;
              }}
              onWheel={(event) => {
                if (!frameData) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const v = { x: ((event.clientX - rect.left) / rect.width) * CW, y: ((event.clientY - rect.top) / rect.height) * CH };
                const before = toImage(v);
                const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
                const nextZoom = Math.max(10, Math.min(6400, zoom * factor));
                const fit = Math.min(CW / frameData.width, CH / frameData.height);
                const nextS = fit * (nextZoom / 100);
                setZoom(nextZoom);
                setPan({ x: v.x - before.x * nextS - (CW - frameData.width * nextS) / 2, y: v.y - before.y * nextS - (CH - frameData.height * nextS) / 2 });
              }}
            />
            {calibrationInstruction && draft && <div className="drawing-instruction">{calibrationInstruction}</div>}
            {contextMenu && (() => {
              if (contextMenu.id === "__cielab__") {
                return (
                  <div className="drawing-context-menu" style={{ left: Math.min(contextMenu.x, CW - 250), top: Math.min(contextMenu.y, CH - 140) }} onClick={(event) => event.stopPropagation()}>
                    <div className="context-title">CIELAB region</div>
                    <button onClick={() => { addScientificComponent(); setContextMenu(null); }}>Add to selected phase: {phases.find((p) => p.id === selectedPhaseId)?.name ?? "Phase"}</button>
                    <button onClick={() => { runWand(toImage({ x: contextMenu.x, y: contextMenu.y })); setContextMenu(null); }}>Keep as selection only</button>
                  </div>
                );
              }
              const item = frame?.drawings?.find((drawing) => drawing.id === contextMenu.id);
              if (!item) return null;
              const patchDrawing = (patch: Partial<Measurement>) => updateFrame(activeIndex, {
                drawings: (frame?.drawings ?? []).map((drawing) => drawing.id === item.id ? { ...drawing, ...patch } : drawing),
              });
              return (
                <div className="drawing-context-menu" style={{ left: Math.min(contextMenu.x, CW - 220), top: Math.min(contextMenu.y, CH - 250) }} onClick={(event) => event.stopPropagation()}>
                  <div className="context-title">{item.label}</div>
                  <button onClick={() => {
                    const measured = buildMeasurement({ type: item.type, points: item.points } as Selection, frameData, detect);
                    if (measured) addMeasurement(activeIndex, measured);
                    setContextMenu(null);
                  }}>Measure</button>
                  {item.type === "Line" && <button onClick={() => {
                    setSelection({ type: "Line", points: item.points });
                    setStatus("Line selected for scale. Enter its known distance, then choose Set scale.");
                    setContextMenu(null);
                  }}>Use to set scale</button>}
                  <div className="context-row"><span>Colour</span>{["#3b82f6", "#f7c948", "#f25f4b", "#7ee787"].map((color) => <button key={color} aria-label={`Set line color ${color}`} className="color-swatch" style={{ backgroundColor: color }} onClick={() => patchDrawing({ strokeColor: color })} />)}</div>
                  <div className="context-row"><span>Width</span>{[1.5, 3, 5].map((width) => <button key={width} onClick={() => patchDrawing({ strokeWidth: width })}>{width === 5 ? "Bold" : width}</button>)}</div>
                  <button className="context-delete" onClick={() => {
                    updateFrame(activeIndex, { drawings: (frame?.drawings ?? []).filter((drawing) => drawing.id !== item.id) });
                    setSelectedId(null);
                    setContextMenu(null);
                  }}>Delete</button>
                </div>
              );
            })()}
            {loupeOn && hasImage && cursorView && (
              <canvas
                ref={loupeRef}
                className="pointer-events-none absolute z-10 rounded-full border-2 border-calibration bg-canvas"
                style={{ ...loupeStyle, width: LOUPE, height: LOUPE }}
              />
            )}
          </div>

          <div className="ij-sunken status-strip mt-3 flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="text-[11px]">
              <strong>{activeTool?.label ?? "Tool"}</strong> — {activeTool?.hint ?? "Choose a tool"}
            </span>
            <span className="ij-num text-muted-foreground">{status}</span>
          </div>

          <div className="mt-4">
            <div className="ij-title mb-2">Results — {frame ? frame.name : "no frame"}</div>
            <ResultsTable
              frame={frame}
              onDelete={(id) =>
                updateFrame(activeIndex, {
                  measurements: (frame?.measurements ?? []).filter((m) => m.id !== id),
                })
              }
            />
            <ScientificResults frames={frames} activeIndex={activeIndex} />
          </div>
        </section>

        {/* Right: calibration + detection */}
        <aside className="inspector-panel space-y-3">
          <div className="ij-raised">
            <div className="ij-title mb-3">Set scale — needle gauge</div>
            <CalibrationPanel
              scale={frame?.scale ?? NO_SCALE}
              onScaleChange={(scale: Scale) => frame && updateFrame(activeIndex, { scale })}
              calibrationPx={calibrationPx}
              onPickCalibrationTool={(instruction) => {
                setCalibrationInstruction(instruction);
                setTool("line");
                setStatus(instruction);
              }}
              disabled={!hasImage}
            />
          </div>

          <div className="ij-raised">
            <div className="ij-title mb-3">CIELAB boundary detection</div>
            <DetectPanel
              detect={detect}
              onDetect={setDetect}
              searchRadius={searchRadius}
              onSearchRadius={setSearchRadius}
              mode={frame?.mode ?? "manual"}
              onMode={(mode) => {
                if (!frame) return;
                updateFrame(activeIndex, { mode });
                if (mode === "auto" && recipe) runAuto(activeIndex, recipe).then(() => setReady((n) => n + 1));
              }}
              recipe={recipe}
              canCapture={Boolean(frame?.measurements.some((measurement) => measurement.source === "manual") || selection)}
              onCapture={captureRecipe}
              onRunFrame={() => recipe && runAuto(activeIndex, recipe).then(() => setReady((n) => n + 1))}
              onRunAll={runAll}
              onPickWand={() => setTool("wand")}
              isReference={activeIndex === 0}
              autoNote={frame?.autoNote ?? ""}
              isRunningAll={isRunningAll}
            />
          </div>

          <div className="ij-raised">
            <div className="ij-title mb-3">Scientific phase composition</div>
            <p className="mb-2 text-[10px] text-muted-foreground">
              Define the physical phases in this image (name them however you like), then trace each one with the
              CIELAB tools above and assign the traced region to a phase below.
            </p>

            <div className="ij-sunken space-y-2 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="ij-title">Phases</div>
                <div className="flex gap-1">
                  <button className={`ij-btn px-2 ${traceScope === "selected" ? "ring-1 ring-primary" : ""}`} onClick={() => setTraceScope("selected")}>Selected</button>
                  <button className={`ij-btn px-2 ${traceScope === "all" ? "ring-1 ring-primary" : ""}`} onClick={() => setTraceScope("all")}>All</button>
                </div>
              </div>
              {phases.map((phase) => {
                const group = scientificRecipe?.groups.find((g) => g.name.toLowerCase() === phase.name.toLowerCase() && g.role === phase.role);
                const visible = phaseTraceVisible[phase.id] ?? group?.traceVisible ?? true;
                return (
                  <div key={phase.id} className="flex items-center gap-1">
                    <span className="inline-block h-3 w-3 shrink-0 rounded-full border border-white/20" style={{ background: phase.color }} title="Phase trace colour" />
                    <input
                      className="ij-field min-w-0 flex-1"
                      value={phase.name}
                      onChange={(e) => renamePhase(phase.id, e.target.value)}
                      placeholder="Phase name"
                    />
                    <select
                      className="ij-field w-[92px] shrink-0"
                      value={phase.role}
                      onChange={(e) => setPhaseRole(phase.id, e.target.value as "target" | "secondary")}
                    >
                      <option value="target">Target</option>
                      <option value="secondary">Secondary</option>
                    </select>
                    <button
                      className={`ij-btn shrink-0 px-2 ${visible ? "" : "opacity-60"}`}
                      title={`${visible ? "Hide" : "Show"} added CIELAB regions for ${phase.name}`}
                      onClick={() => togglePhaseTrace(phase.id)}
                      disabled={!group}
                    >
                      {visible ? "◉" : "○"}
                    </button>
                    <button
                      className="ij-btn shrink-0 px-2"
                      title="Remove phase"
                      onClick={() => removePhase(phase.id)}
                      disabled={phases.length <= 1}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              <button className="ij-btn w-full" onClick={addPhase}>
                + Add phase
              </button>
              <div className="grid grid-cols-2 gap-1">
                <button className="ij-btn" onClick={() => setPhaseTraceVisible(Object.fromEntries(phases.map((p) => [p.id, true])))}>Show all traces</button>
                <button className="ij-btn" onClick={() => setPhaseTraceVisible(Object.fromEntries(phases.map((p) => [p.id, false])))}>Hide all traces</button>
              </div>
            </div>

            <div className="mt-2">
              <label className="ij-title block">Add traced region to</label>
              <select
                className="ij-field mt-1 w-full"
                value={selectedPhaseId}
                onChange={(e) => setSelectedPhaseId(e.target.value)}
              >
                {phases.map((phase) => (
                  <option key={phase.id} value={phase.id}>
                    {phase.name} · {phase.role}
                  </option>
                ))}
              </select>
            </div>
            <button className="ij-btn mt-2 w-full" onClick={addScientificComponent} disabled={activeIndex !== 0 || selection?.type !== "Region"}>
              Add current CIELAB region to phase
            </button>
            <div className="ij-sunken mt-2 space-y-1.5 p-2">
              <label className="ij-title block">Define a measurable quantity</label>
              <p className="text-[10px] text-muted-foreground">
                1. Go to frame 1. Draw a <strong>line</strong> (Line tool) or an <strong>angle</strong> (Angle tool: arm end, vertex, arm end).<br />
                2. Say what it is. 3. Press the button. It is then re-located and re-measured in every frame.
              </p>
              <select className="ij-field w-full" value={qtyKind} onChange={(e) => { setQtyKind(e.target.value as QtyKind); setQtyName(""); }}>
                {(Object.keys(QTY) as QtyKind[]).map((k) => (
                  <option key={k} value={k}>{QTY[k].label}</option>
                ))}
              </select>
              <input className="ij-field w-full" placeholder={`Name (default: ${QTY[qtyKind].defaultName})`} value={qtyName} onChange={(e) => setQtyName(e.target.value)} />
              <div className="text-[10px]">
                {QTY[qtyKind].shape === "angle"
                  ? (selectedAnglePoints && selectedAnglePoints.length >= 3 ? <span className="text-emerald-400">✓ Angle ready to save</span> : <span className="text-amber-300">No angle selected yet — use the Angle tool (3 clicks), or click a saved angle.</span>)
                  : (selectedLinePoints ? <span className="text-emerald-400">✓ Line ready to save</span> : <span className="text-amber-300">No line selected yet — draw one, or click a saved line.</span>)}
              </div>
              <button
                className="ij-btn w-full"
                onClick={applyQuantity}
                disabled={activeIndex !== 0 || (QTY[qtyKind].shape === "angle" ? !selectedAnglePoints || selectedAnglePoints.length < 3 : !selectedLinePoints)}
              >
                Save “{qtyName.trim() || QTY[qtyKind].defaultName}” as a tracked quantity
              </button>
              {activeIndex !== 0 && <p className="text-[10px] text-amber-300">Saving is done on frame 1. Go to frame 1 (or right-click an image → Set as reference).</p>}
            </div>
            <div className="ij-sunken mt-2 space-y-2 p-2">
              {scientificRecipe?.groups.length ? scientificRecipe.groups.map((group, gi) => {
                const phase = phases.find((p) => p.name.toLowerCase() === group.name.toLowerCase() && p.role === group.role);
                const visible = phase ? (phaseTraceVisible[phase.id] ?? group.traceVisible ?? true) : (group.traceVisible ?? true);
                return (
                  <div key={group.id} className="rounded border border-white/10 p-2">
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: group.traceColor ?? phaseTraceColor(gi) }} /><strong>{group.name}</strong> · {group.role}</span>
                      <span className="ij-num">{group.components.length} component{group.components.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <button className="ij-btn px-2" onClick={() => phase ? togglePhaseTrace(phase.id) : updateScientificGroup(group.id, { traceVisible: !visible })}>{visible ? "Hide traces" : "Show traces"}</button>
                      <input type="color" value={group.traceColor ?? phaseTraceColor(gi)} title="Trace colour" onChange={(e) => updateScientificGroup(group.id, { traceColor: e.target.value })} className="h-6 w-9 rounded border border-white/10 bg-transparent p-0" />
                      <label className="text-[9px]">Weight <input className="align-middle" type="range" min="1" max="6" step="0.5" value={group.traceWidth ?? 2.5} onChange={(e) => updateScientificGroup(group.id, { traceWidth: Number(e.target.value) })} /></label>
                      <label className="flex items-center gap-1 text-[9px]"><input type="checkbox" checked={Boolean(group.traceDashed)} onChange={(e) => updateScientificGroup(group.id, { traceDashed: e.target.checked })} /> dashed</label>
                    </div>
                    <div className="mt-1 space-y-1">
                      {group.components.map((component, ci) => (
                        <div key={component.id} className="flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
                          <span>Region {ci + 1}</span>
                          <button className="ij-btn px-1.5" title="Delete this captured CIELAB region" onClick={() => setScientificRecipe((current) => current ? { ...current, groups: current.groups.map((g) => g.id === group.id ? { ...g, components: g.components.filter((c) => c.id !== component.id) } : g).filter((g) => g.components.length > 0) } : current)}>✕</button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }) : <span className="text-[10px] text-muted-foreground">No scientific phases captured yet.</span>}
              {(scientificRecipe?.lines.length || scientificRecipe?.angles?.length) ? (
                <div className="space-y-1.5">
                  <div className="ij-title">Tracked quantities</div>
                  {scientificRecipe!.lines.map((line) => {
                    const isLast = frames.length > 1 && activeIndex === frames.length - 1;
                    const tracked = line.role === "height" || line.role === "length";
                    return (
                      <div key={line.id} className="rounded border border-white/10 p-1.5 text-[10px]">
                        <div className="flex items-center justify-between gap-2">
                          <span><strong>{line.label}</strong> · line · {line.role === "height" ? "phase extent axis" : line.role === "base" ? "base level" : line.role === "chord" ? "chord span" : "length"}</span>
                          <button className="ij-btn px-2" title="Remove" onClick={() => removeScientificLine(line.id)}>✕</button>
                        </div>
                        {tracked && frames.length > 1 && (
                          <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
                            {line.endRel ? <span className="text-emerald-400">✓ last-frame position set</span> : <span>no last-frame position</span>}
                            <button className="ij-btn px-1.5" disabled={!isLast || !selectedLinePoints} title="Open the last frame, select the same line there, then press" onClick={() => setEndKeyframe("line", line.id)}>Set from selected line (last frame)</button>
                            {line.endRel && <button className="ij-btn px-1.5" onClick={() => clearEndKeyframe("line", line.id)}>Clear</button>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(scientificRecipe!.angles ?? []).map((angle) => {
                    const isLast = frames.length > 1 && activeIndex === frames.length - 1;
                    return (
                      <div key={angle.id} className="rounded border border-white/10 p-1.5 text-[10px]">
                        <div className="flex items-center justify-between gap-2">
                          <span><strong>{angle.label}</strong> · angle{angle.useBoundaryTangent ? " · boundary tangent at vertex" : " · 3-point"}</span>
                          <button className="ij-btn px-2" title="Remove" onClick={() => removeScientificAngle(angle.id)}>✕</button>
                        </div>
                        {frames.length > 1 && (
                          <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
                            {angle.endRel ? <span className="text-emerald-400">✓ last-frame position set</span> : <span>no last-frame position</span>}
                            <button className="ij-btn px-1.5" disabled={!isLast || !selectedAnglePoints} title="Open the last frame, select the same angle there, then press" onClick={() => setEndKeyframe("angle", angle.id)}>Set from selected angle (last frame)</button>
                            {angle.endRel && <button className="ij-btn px-1.5" onClick={() => clearEndKeyframe("angle", angle.id)}>Clear</button>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : <div className="pt-1 text-[10px] text-muted-foreground">No quantities defined yet.</div>}
            </div>
            <div className="ij-sunken mt-2 space-y-2 p-2">
              <div className="ij-title">Interacting CIELAB surfaces</div>
              <p className="text-[10px] text-muted-foreground">When phase regions touch or overlap in colour space, PixMatch resolves shared pixels between phases instead of allowing one phase to silently absorb the other.</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[9px]"><span className="ij-title block">Overlap policy</span><select className="ij-field mt-1 w-full" value={scientificRecipe?.interaction?.mode ?? "resolve-overlaps"} onChange={(e) => setScientificRecipe((current) => current ? { ...current, interaction: { ...(current.interaction ?? { ambiguityMargin: 1.5, spatialTieBreak: 0.08 }), mode: e.target.value as "resolve-overlaps" | "allow-overlaps" } } : current)}>
                  <option value="resolve-overlaps">Resolve competing phases</option>
                  <option value="allow-overlaps">Allow overlap</option>
                </select></label>
                <label className="text-[9px]"><span className="ij-title block">Ambiguity margin</span><input className="ij-field mt-1 w-full" type="number" min="0" max="20" step="0.25" value={scientificRecipe?.interaction?.ambiguityMargin ?? 1.5} onChange={(e) => setScientificRecipe((current) => current ? { ...current, interaction: { ...(current.interaction ?? { mode: "resolve-overlaps", spatialTieBreak: 0.08 }), ambiguityMargin: Math.max(0, Number(e.target.value) || 0) } } : current)} /></label>
              </div>
              <p className="text-[9px] text-muted-foreground">A close-match count is reported after each sequence run so interacting boundaries can be reviewed rather than hidden.</p>
            </div>
            <label className="mt-2 flex items-start gap-2 text-[10px]">
              <input type="checkbox" className="mt-0.5" checked={matchIllumination} onChange={(e) => setMatchIllumination(e.target.checked)} />
              <span>Match illumination to frame 1 (aligns each frame's border colour with frame 1 before matching). Turn off if the object touches the frame edge.</span>
            </label>
            <button className="ij-btn mt-2 w-full" onClick={runScientificAll} disabled={!runnableScientific || isRunningAll}>
              {isRunningAll ? "Measuring sequence…" : "Run scientific measurement on all frames"}
            </button>
          </div>

          <div className="ij-raised">
            <div className="ij-title mb-3">PIV · image velocimetry</div>
            <p className="mb-2 text-[10px] text-muted-foreground">
              Track image texture/particles between frames. Consecutive frames are used by default; enter the acquisition FPS to convert displacement into velocity.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px]"><span className="ij-title block">Window px</span><input className="ij-field mt-1 w-full" type="number" min="16" max="256" step="8" value={pivConfig.windowSize} onChange={(e) => setPivConfig((c) => ({ ...c, windowSize: Math.max(16, Number(e.target.value) || 32) }))} /></label>
              <label className="text-[10px]"><span className="ij-title block">Grid step px</span><input className="ij-field mt-1 w-full" type="number" min="8" max="256" step="4" value={pivConfig.step} onChange={(e) => setPivConfig((c) => ({ ...c, step: Math.max(8, Number(e.target.value) || 32) }))} /></label>
              <label className="text-[10px]"><span className="ij-title block">Search ±px</span><input className="ij-field mt-1 w-full" type="number" min="2" max="32" step="1" value={pivConfig.searchRadius} onChange={(e) => setPivConfig((c) => ({ ...c, searchRadius: Math.max(2, Number(e.target.value) || 6) }))} /></label>
              <label className="text-[10px]"><span className="ij-title block">FPS</span><input className="ij-field mt-1 w-full" type="number" min="0.001" step="0.1" value={pivConfig.fps} onChange={(e) => setPivConfig((c) => ({ ...c, fps: Math.max(0.001, Number(e.target.value) || 30) }))} /></label>
              <label className="text-[10px]"><span className="ij-title block">Frame stride</span><input className="ij-field mt-1 w-full" type="number" min="1" max="100" step="1" value={pivConfig.frameStride} onChange={(e) => setPivConfig((c) => ({ ...c, frameStride: Math.max(1, Math.round(Number(e.target.value) || 1)) }))} /></label>
              <label className="text-[10px]"><span className="ij-title block">Min correlation</span><input className="ij-field mt-1 w-full" type="number" min="0" max="0.99" step="0.05" value={pivConfig.minCorrelation} onChange={(e) => setPivConfig((c) => ({ ...c, minCorrelation: Math.max(0, Math.min(0.99, Number(e.target.value) || 0.35)) }))} /></label>
              <label className="text-[10px]"><span className="ij-title block">Min peak ratio</span><input className="ij-field mt-1 w-full" type="number" min="1" max="3" step="0.01" value={pivConfig.minSNR} onChange={(e) => setPivConfig((c) => ({ ...c, minSNR: Math.max(1, Math.min(3, Number(e.target.value) || 1)) }))} /></label>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[10px]"><input type="checkbox" checked={pivConfig.twoPass} onChange={(e) => setPivConfig((c) => ({ ...c, twoPass: e.target.checked }))} /><span>Two-pass refinement</span></label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button className="ij-btn" onClick={runPivAll} disabled={isRunningPiv || frames.length < 2}>{isRunningPiv ? "Computing…" : "Run PIV on bulk"}</button>
              <button className="ij-btn" onClick={() => download("pixmatch-piv.csv", exportPivCsv(pivResults), "text/csv")} disabled={!pivResults.length}>Export vectors</button>
            </div>
            <button className="ij-btn mt-2 w-full" onClick={clearPiv} disabled={!pivResults.length}>Clear PIV results</button>
            <div className="ij-sunken mt-2 p-2 text-[10px]">
              {pivResults.length ? (() => { const r = pivResults.find((x) => x.frameA === activeIndex) ?? pivResults[0]; const valid = pivResults.reduce((n, x) => n + x.validCount, 0); return <div className="grid grid-cols-2 gap-1"><Kv k="Pairs" v={String(pivResults.length)} /><Kv k="Valid vectors" v={String(valid)} /><Kv k="Mean u" v={`${fmt(r.meanU, 2)} px/frame`} /><Kv k="Mean v" v={`${fmt(r.meanV, 2)} px/frame`} /><Kv k="dt" v={`${fmt(r.dtSeconds, 4)} s`} /><Kv k="Mean corr." v={fmt(r.meanCorrelation, 3)} /></div>; })() : <span className="text-muted-foreground">No PIV results. Load a bulk sequence, set FPS, then run.</span>}
            </div>
          </div>

          {showHistogram && (
            <div className="ij-raised">
              <div className="ij-title mb-3">Histogram · detection limits</div>
              <HistogramView
                bins={bins}
                channel={histChannel}
                onChannel={setHistChannel}
                limits={detect.channelLimits}
                onLimits={(next) => setDetect((d) => ({ ...d, channelLimits: next }))}
                canFit={selection?.type === "Region"}
                onFit={fitLimitsToSelection}
              />
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function ScientificResults({ frames, activeIndex }: { frames: FrameState[]; activeIndex: number }) {
  // Columns are built only from measurements that were actually defined and run.
  const lineCols = (() => {
    const seen = new Map<string, string>();
    frames.forEach((f) => f.scientificLines?.forEach((r) => seen.set(r.lineId, r.label)));
    return [...seen].map(([id, label]) => ({ id, label }));
  })();
  const angleCols = (() => {
    const seen = new Map<string, string>();
    frames.forEach((f) => f.scientificAngles?.forEach((r) => seen.set(r.angleId, r.label)));
    return [...seen].map(([id, label]) => ({ id, label }));
  })();
  const hasExtent = frames.some((f) => f.scientific?.some((r) => r.role === "target" && r.heightPx != null));
  const hasSpan = frames.some((f) => f.scientific?.some((r) => r.role === "target" && r.contactDiameterPx != null));
  const anyResult = lineCols.length > 0 || angleCols.length > 0 || hasExtent || hasSpan;

  type Col = { key: string; label: string; get: (f: FrameState) => number | null; unit: (f: FrameState) => string };
  const cols: Col[] = [
    ...lineCols.map((c) => ({
      key: `line-${c.id}`, label: c.label,
      get: (f: FrameState) => { const r = f.scientificLines?.find((x) => x.lineId === c.id); return r ? (r.lengthPhysical ?? r.lengthPx) : null; },
      unit: (f: FrameState) => (f.scientificLines?.find((x) => x.lineId === c.id)?.lengthPhysical != null ? f.scale.unit : "px"),
    })),
    ...angleCols.map((c) => ({
      key: `angle-${c.id}`, label: c.label,
      get: (f: FrameState) => f.scientificAngles?.find((x) => x.angleId === c.id)?.angleDeg ?? null,
      unit: () => "°",
    })),
    ...(hasExtent ? [{
      key: "extent", label: "Phase extent",
      get: (f: FrameState) => { const r = f.scientific?.find((x) => x.role === "target"); return r ? (r.heightPhysical ?? r.heightPx) : null; },
      unit: (f: FrameState) => (f.scientific?.find((x) => x.role === "target")?.heightPhysical != null ? f.scale.unit : "px"),
    }] : []),
    ...(hasSpan ? [{
      key: "span", label: "Chord span",
      get: (f: FrameState) => { const r = f.scientific?.find((x) => x.role === "target"); return r ? (r.contactDiameterPhysical ?? r.contactDiameterPx) : null; },
      unit: (f: FrameState) => (f.scientific?.find((x) => x.role === "target")?.contactDiameterPhysical != null ? f.scale.unit : "px"),
    }] : []),
  ];
  const statusOf = (f: FrameState) => {
    const all = [...(f.scientificLines?.map((r) => r.status) ?? []), ...(f.scientificAngles?.map((r) => r.status) ?? []), ...(f.scientific?.map((r) => r.status) ?? [])];
    if (!all.length) return "—";
    return all.every((x) => x === "VALID") ? "VALID" : all.find((x) => x !== "VALID")!;
  };
  const chart = cols[0];
  const chartVals = chart ? frames.map((f, i) => ({ frame: i + 1, v: chart.get(f) })).filter((r): r is { frame: number; v: number } => r.v != null) : [];
  const maxV = Math.max(1e-9, ...chartVals.map((r) => r.v));
  const cur = frames[activeIndex];
  return (
    <div className="mt-3 ij-sunken p-2">
      <div className="ij-title mb-2">Scientific measurements</div>
      <div className="grid grid-cols-2 gap-2 text-[10px]">
        {cols.length ? cols.map((c) => {
          const v = cur ? c.get(cur) : null;
          return <Kv key={c.key} k={c.label} v={v != null && cur ? `${fmt(v, 3)} ${c.unit(cur)}` : "—"} />;
        }) : <Kv k="Measurements" v="—" />}
        <Kv k="Status" v={cur ? statusOf(cur) : "—"} />
      </div>
      <div className="mt-2 h-[180px] overflow-hidden rounded border border-border bg-background p-1">
        {chartVals.length < 2 ? (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
            Set up measurements on reference frame 1, then run the scientific sequence.
          </div>
        ) : (
          <svg viewBox="0 0 900 170" className="h-full w-full" preserveAspectRatio="none">
            <line x1="35" y1="145" x2="890" y2="145" stroke="currentColor" opacity=".25" />
            <line x1="35" y1="15" x2="35" y2="145" stroke="currentColor" opacity=".25" />
            <polyline
              fill="none" stroke="#ff4d6d" strokeWidth="2.5"
              points={chartVals.map((r) => `${35 + ((r.frame - 1) / Math.max(1, frames.length - 1)) * 855},${145 - (r.v / maxV) * 125}`).join(" ")}
            />
            {chartVals.map((r) => (
              <circle key={r.frame} cx={35 + ((r.frame - 1) / Math.max(1, frames.length - 1)) * 855} cy={145 - (r.v / maxV) * 125} r={3} fill="#ff4d6d" />
            ))}
            <text x="40" y="12" fontSize="10" fill="currentColor">{chart.label} ({frames[0] ? chart.unit(frames[0]) : ""})</text>
            <text x="820" y="163" fontSize="10" fill="currentColor">Frame</text>
          </svg>
        )}
      </div>
      {anyResult && (
        <div className="mt-2 max-h-[150px] overflow-auto">
          <table className="w-full border-collapse text-[10px]">
            <thead><tr><th className="text-left">Frame</th>{cols.map((c) => <th key={c.key} className="text-left">{c.label}</th>)}<th className="text-left">Status</th></tr></thead>
            <tbody>
              {frames.map((f, i) => (
                <tr key={f.id} className={i === activeIndex ? "bg-primary/10" : ""}>
                  <td>{i + 1} · {f.name}</td>
                  {cols.map((c) => { const v = c.get(f); return <td key={c.key}>{v != null ? `${fmt(v, 3)} ${c.unit(f)}` : "—"}</td>; })}
                  <td>{statusOf(f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------- pure helpers ---------------- */

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase text-muted-foreground">{k}</span>
      <span className="ij-num truncate">{v}</span>
    </div>
  );
}

function rectFrom(points: Pt[]) {
  const [a, b] = points;
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function hitTest(m: Measurement, p: Pt, tol: number) {
  if (m.type === "Point" || m.type === "Region") return dist(m.points[0], p) < Math.max(tol, 6);
  if (m.type === "Rectangle" || m.type === "Oval") {
    const r = rectFrom(m.points);
    return p.x > r.x - tol && p.y > r.y - tol && p.x < r.x + r.w + tol && p.y < r.y + r.h + tol;
  }
  for (let i = 0; i < m.points.length - 1; i++) {
    const a = m.points[i];
    const b = m.points[i + 1];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    let t = len2 ? ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))) < tol) return true;
  }
  return false;
}

function labelFor(m: Measurement, scale: Scale) {
  if (m.type === "Angle") return `${fmt(m.angleDeg, 1)}°`;
  if (m.type === "Point") return m.rgb ? `${m.rgb.r},${m.rgb.g},${m.rgb.b}` : m.label;
  if (m.areaPx != null) {
    const area = toUnitArea(m.areaPx, scale)!;
    return `${fmt(area.value, 2)} ${area.unit}`;
  }
  const len = toUnitLength(m.lengthPx, scale);
  return len ? `${fmt(len.value, 2)} ${len.unit}` : m.label;
}

function buildMeasurement(
  sel: Selection,
  frameData: FrameData | undefined,
  detect: DetectOptions,
): Measurement | null {
  if (sel.type === "Region")
    return measurementFromSegment(sel.seg, "Phase", sel.deltaE, "manual");

  const base = { id: newId(), source: "manual" as const, points: sel.points };

  if (sel.type === "Line") {
    const [a, b] = sel.points;
    return {
      ...base,
      label: "Line",
      type: "Line",
      lengthPx: dist(a, b),
      angleDeg: (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI,
    };
  }
  if (sel.type === "Angle") {
    const [a, v, b] = sel.points;
    return { ...base, label: "Angle", type: "Angle", angleDeg: angleBetween(a, v, b) };
  }
  if (sel.type === "Point") {
    if (!frameData) return null;
    const p = sel.points[0];
    const xi = Math.max(0, Math.min(frameData.width - 1, Math.round(p.x)));
    const yi = Math.max(0, Math.min(frameData.height - 1, Math.round(p.y)));
    const o = (yi * frameData.width + xi) * 4;
    const rgb = {
      r: frameData.data.data[o],
      g: frameData.data.data[o + 1],
      b: frameData.data.data[o + 2],
    };
    const lab = rgbToLab(rgb.r, rgb.g, rgb.b);
    return {
      ...base,
      label: `Probe ${xi},${yi}`,
      type: "Point",
      rgb,
      meanLab: lab,
      deltaE: 0,
    };
  }
  const r = rectFrom(sel.points);
  const isOval = sel.type === "Oval";
  const areaPx = isOval ? (Math.PI * r.w * r.h) / 4 : r.w * r.h;
  const perimeterPx = isOval
    ? Math.PI * (1.5 * (r.w / 2 + r.h / 2) - Math.sqrt((r.w / 2) * (r.h / 2)))
    : 2 * (r.w + r.h);
  const stats = frameData ? roiStats(frameData, r, isOval, detect.metric) : null;
  return {
    ...base,
    label: isOval ? "Oval ROI" : "Rect ROI",
    type: isOval ? "Oval" : "Rectangle",
    areaPx,
    perimeterPx,
    feretMaxPx: Math.hypot(r.w, r.h),
    feretMinPx: Math.min(r.w, r.h),
    meanLab: stats?.meanLab,
    deltaE: stats?.spread,
  };
}

/** Mean LAB and ΔE spread inside a rectangular/elliptical ROI. */
function roiStats(
  frameData: FrameData,
  r: { x: number; y: number; w: number; h: number },
  oval: boolean,
  metric: DetectOptions["metric"],
) {
  const { field } = frameData;
  let L = 0, a = 0, b = 0, n = 0;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(field.height, r.y + r.h); y++)
    for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(field.width, r.x + r.w); x++) {
      if (oval && ((x - cx) / (r.w / 2)) ** 2 + ((y - cy) / (r.h / 2)) ** 2 > 1) continue;
      const i = y * field.width + x;
      L += field.L[i];
      a += field.A[i];
      b += field.B[i];
      n++;
    }
  if (!n) return null;
  const meanLab: LAB = { L: L / n, a: a / n, b: b / n };
  let spread = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(n) / 24));
  for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(field.height, r.y + r.h); y += step)
    for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(field.width, r.x + r.w); x += step) {
      const i = y * field.width + x;
      spread += labDistance({ L: field.L[i], a: field.A[i], b: field.B[i] }, meanLab, metric);
      count++;
    }
  return { meanLab, spread: count ? spread / count : 0 };
}
