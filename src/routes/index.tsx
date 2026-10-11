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
import {
  DEFAULT_DETECT,
  detectRegion,
  histogram,
  relocateSeed,
  toLabField,
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
import { calculateScientificHeight, segmentScientificGroup, type ScientificPhaseGroup, type ScientificRecipe } from "@/lib/scientific";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PixMatch — ImageJ-style image analysis workspace" },
      {
        name: "description",
        content:
          "Calibrate with a needle gauge, trace phases with CIELAB boundary detection, then replay the same recipe automatically across an entire image sequence.",
      },
      { property: "og:title", content: "PixMatch — ImageJ-style image analysis workspace" },
      {
        property: "og:description",
        content:
          "Manual measurement on the reference frame, automatic CIELAB propagation on the rest. Needle gauge calibration, results table, CSV and HTML reports.",
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

/** A user-defined physical phase (e.g. "Water", "Oil") in the scientific composition panel. */
type ScientificPhaseDef = {
  id: string;
  name: string;
  role: "target" | "secondary";
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [calibrationInstruction, setCalibrationInstruction] = useState<string | null>(null);
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [phases, setPhases] = useState<ScientificPhaseDef[]>([{ id: newId(), name: "Phase 1", role: "target" }]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string>(() => phases[0].id);
  const [scientificRecipe, setScientificRecipe] = useState<ScientificRecipe | null>(null);

  const frame = frames[activeIndex];
  const frameData = frame ? cacheRef.current.get(frame.id) : undefined;
  const hasImage = Boolean(frame && frameData);

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
    setBins(histogram(frameData.data, roi));
  }, [frameData, showHistogram, selection, ready]);

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
      { id, name: `Phase ${current.length + 1}`, role: current.some((p) => p.role === "target") ? "secondary" : "target" },
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

  function addScientificComponent() {
    const activePhase = phases.find((p) => p.id === selectedPhaseId) ?? phases[0];
    if (!frame || !frameData || activeIndex !== 0 || selection?.type !== "Region" || !activePhase) {
      setStatus("On reference frame 1, use Wand to trace one phase, then add that region to a scientific phase.");
      return;
    }
    const seg = selection.seg;
    const component = {
      id: newId(),
      label: activePhase.name.trim() || "Phase",
      referenceLab: seg.meanLab,
      pointsRel: [{ x: seg.centroid.x / frameData.width, y: seg.centroid.y / frameData.height }],
      detect: { ...detect },
      searchRadiusRel: searchRadius / Math.max(frameData.width, frameData.height),
    };
    setScientificRecipe((current) => {
      const base: ScientificRecipe = current ?? {
        groups: [],
        scale: { ...frame.scale },
        capturedFrom: frame.name,
        capturedAt: new Date().toLocaleString(),
      };
      const groups = [...base.groups];
      const existing = groups.find((g) => g.name.toLowerCase() === component.label.toLowerCase() && g.role === activePhase.role);
      if (existing) {
        existing.components = [...existing.components, component];
      } else {
        groups.push({ id: newId(), name: component.label, role: activePhase.role, components: [component] });
      }
      return { ...base, groups, scale: { ...frame.scale } };
    });
    setStatus(`Added traced ${activePhase.role} component to “${component.label}”. Add another component to build a composite phase.`);
    clearTemporarySelection();
  }

  function setScientificBaseline() {
    if (!frame || !frameData || activeIndex !== 0 || selection?.type !== "Line") {
      setStatus("Draw the droplet/base line on reference frame 1, select it, then set it as the scientific baseline.");
      return;
    }
    const [a, b] = selection.points;
    setScientificRecipe((current) => ({
      ...(current ?? { groups: [], scale: { ...frame.scale }, capturedFrom: frame.name, capturedAt: new Date().toLocaleString() }),
      baseline: {
        p1Rel: { x: a.x / frameData.width, y: a.y / frameData.height },
        p2Rel: { x: b.x / frameData.width, y: b.y / frameData.height },
      },
      scale: { ...frame.scale },
    }));
    setStatus("Scientific baseline captured. Composite water height will be measured from its top boundary to this baseline.");
  }

  const runScientificFrame = useCallback(async (index: number, recipe: ScientificRecipe, priorSeeds?: Map<string, Pt>) => {
    const target = frames[index];
    if (!target) return new Map<string, Pt>();
    const data = await loadFrame(target);
    const results = [] as NonNullable<FrameState["scientific"]>;
    let nextSeeds = new Map<string, Pt>();
    for (const group of recipe.groups) {
      const found = segmentScientificGroup(data.field, group, priorSeeds);
      nextSeeds = new Map([...nextSeeds, ...found.seeds]);
      if (!found.segment) {
        results.push({
          phase: group.name,
          role: group.role,
          heightPx: null,
          heightPhysical: null,
          contactDiameterPx: null,
          contactDiameterPhysical: null,
          topY: null,
          baselineY: null,
          componentCount: 0,
          confidence: 0,
          status: "MISSING_PHASE",
        });
        continue;
      }
      results.push(calculateScientificHeight(found.segment, recipe, target.scale.pxPerUnit ? target.scale : recipe.scale, group, found.componentCount));
    }
    setFrames((current) => current.map((f, i) => i === index ? {
      ...f,
      scale: f.scale.pxPerUnit ? f.scale : { ...recipe.scale, origin: "inherited", note: `scientific inherited · ${recipe.scale.note}` },
      scientific: results,
      analyzed: true,
      autoNote: `${results.filter((r) => r.status === "VALID").length}/${results.length} scientific phase(s) valid`,
    } : f));
    return nextSeeds;
  }, [frames, loadFrame]);

  async function runScientificAll() {
    if (!scientificRecipe || isRunningAll) return;
    setIsRunningAll(true);
    let seeds = new Map<string, Pt>();
    try {
      for (let i = 0; i < frames.length; i++) {
        setStatus(`Scientific measurement ${i + 1}/${frames.length}: ${frames[i]?.name ?? "frame"}…`);
        seeds = await runScientificFrame(i, scientificRecipe, seeds);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      setReady((n) => n + 1);
      setStatus("Scientific phase measurement completed for the sequence.");
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
    if (!source.length) {
      setStatus("Measure at least one ROI on reference image 1, then capture.");
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
    });
    setStatus(`${steps.length}-step workflow captured from ${frame.name}. Later frames can now run automatically.`);
  }

  const runAuto = useCallback(
    async (index: number, activeRecipe: Recipe, priorAnchors?: Map<number, Pt>) => {
      const target = frames[index];
      if (!target || index === 0) return new Map<number, Pt>();
      const data = await loadFrame(target);
      const nextAnchors = new Map<number, Pt>();
      const results: Measurement[] = [];
      const failures: string[] = [];
      const notes: string[] = [];

      for (let stepIndex = 0; stepIndex < activeRecipe.steps.length; stepIndex++) {
        const step = activeRecipe.steps[stepIndex];
        const points = step.pointsRel.map((point) => ({ x: point.x * data.width, y: point.y * data.height }));
        if (!points.length) continue;

        if (step.type === "Region" && step.referenceLab && step.detect) {
          const prior = priorAnchors?.get(stepIndex) ?? step.pointsRel[0];
          const around = { x: prior.x * data.width, y: prior.y * data.height };
          const baseRadius = Math.max(4, Math.round((step.searchRadiusRel ?? 0.05) * Math.max(data.width, data.height)));
          let relocated = relocateSeed(data.field, step.referenceLab, around, baseRadius, step.detect.metric);
          let seg = detectRegion(data.field, relocated.seed, step.detect);
          if (!seg) {
            relocated = relocateSeed(data.field, step.referenceLab, around, baseRadius * 2, step.detect.metric);
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
          const prior = priorAnchors?.get(stepIndex) ?? step.pointsRel[0];
          const around = { x: prior.x * data.width, y: prior.y * data.height };
          const radius = Math.max(4, Math.round((step.searchRadiusRel ?? 0.05) * Math.max(data.width, data.height)));
          const relocated = relocateSeed(data.field, step.referenceLab, around, radius, "ciede2000");
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
      setReady((n) => n + 1);
      setStatus(failed.length ? `Recipe completed on ${completed} frame(s); ${failed.length} need review.` : `Recipe applied to ${completed} frame(s).`);
    } finally {
      setIsRunningAll(false);
    }
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

  const menu = {
    File: [
      { label: "Open images…", action: () => document.getElementById("pm-file")?.click() },
      {
        label: "Export results (CSV)",
        action: () => download("pixmatch-results.csv", exportCsv(frames), "text/csv"),
      },
      {
        label: "Export report (HTML)",
        action: () =>
          download("pixmatch-report.html", exportHtml(frames, recipe), "text/html"),
      },
      {
        label: "Close frame",
        action: () => {
          if (!frame) return;
          cacheRef.current.delete(frame.id);
          URL.revokeObjectURL(frame.url);
          void removeStoredImage(frame.id);
          setFrames((c) => c.filter((_, i) => i !== activeIndex));
          setActiveIndex(0);
          setSelection(null);
        },
      },
    ],
    Edit: [
      { label: "Draw selection", action: drawSelectionToImage },
      { label: "Restore selection", action: restoreSelection },
      { label: "Select none", action: () => { clearTemporarySelection(); setSelectedId(null); } },
      {
        label: "Delete permanent drawing",
        action: () => {
          if (!selectedId) return;
          updateFrame(activeIndex, {
            drawings: (frame?.drawings ?? []).filter((m) => m.id !== selectedId),
          });
          setSelectedId(null);
        },
      },
      { label: "Clear results (frame)", action: () => updateFrame(activeIndex, { measurements: [] }) },
      {
        label: "Clear results (all frames)",
        action: () => setFrames((c) => c.map((f) => ({ ...f, measurements: [], analyzed: false, autoNote: "" }))),
      },
    ],
    Image: [
      { label: "Zoom in", action: () => setZoom((z) => Math.min(1600, z * 1.5)) },
      { label: "Zoom out", action: () => setZoom((z) => Math.max(10, z / 1.5)) },
      { label: "Fit to window", action: () => { setZoom(100); setPan({ x: 0, y: 0 }); } },
      { label: "Actual size (100%)", action: () => { if (!frameData) return; const fit = Math.min(CW / frameData.width, CH / frameData.height); setZoom(100 / fit); setPan({ x: 0, y: 0 }); } },
      { label: showOverlay ? "Hide overlay" : "Show overlay", action: () => setShowOverlay((v) => !v) },
      { label: loupeOn ? "Hide magnifier" : "Show magnifier", action: () => setLoupeOn((v) => !v) },
    ],
    Analyze: [
      { label: "Measure selection", action: () => measureSelection() },
      { label: showHistogram ? "Hide histogram" : "Histogram", action: () => setShowHistogram((v) => !v) },
      { label: autoMeasure ? "Auto-measure: on" : "Auto-measure: off", action: () => setAutoMeasure((v) => !v) },
    ],
    Batch: [
      { label: "Capture recipe from this frame", action: captureRecipe },
      { label: "Run recipe on this frame", action: () => recipe && runAuto(activeIndex, recipe).then(() => setReady((n) => n + 1)) },
      { label: "Run recipe on all frames", action: runAll },
      {
        label: "Set this frame to manual",
        action: () => updateFrame(activeIndex, { mode: "manual" }),
      },
    ],
  } satisfies Record<string, { label: string; action: () => void }[]>;

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
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
    <div className="min-h-screen bg-background text-foreground" onClick={(event) => { setOpenMenu(null); setContextMenu(null); const target = event.target as HTMLElement; if (!target.closest("canvas, button, input, select, [data-keep-selection]")) clearTemporarySelection(); }}>
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
                setOpenMenu(openMenu === name ? null : name);
              }}
            >
              {name}
            </button>
            {openMenu === name && (
              <div className="ij-raised absolute left-0 top-full z-30 mt-2 min-w-[230px] p-1.5 shadow-lg">
                {items.map((item) => (
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
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className="ij-num text-muted-foreground">
            {frames.length} frame(s) · {frame ? frame.mode : "—"}
          </span>
          <button
            className="ij-btn"
            onClick={() => download("pixmatch-report.html", exportHtml(frames, recipe), "text/html")}
          >
            <Download size={12} className="mr-1 inline" />
            Report
          </button>
        </div>
      </header>

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
            <button className="ij-btn" onClick={() => setZoom((z) => Math.min(1600, z * 1.5))}>
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
            <button className="ij-btn" onClick={() => setLoupeZoom((z) => (z >= 10 ? 2 : z + 2))}>
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
            />
            {calibrationInstruction && draft && <div className="drawing-instruction">{calibrationInstruction}</div>}
            {contextMenu && (() => {
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
              Define the physical phases in this image (water, oil, or anything else), then trace each one with the
              CIELAB tools above and assign the traced region to a phase below.
            </p>

            <div className="ij-sunken space-y-2 p-2">
              <div className="ij-title">Phases</div>
              {phases.map((phase) => (
                <div key={phase.id} className="flex items-center gap-1">
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
                    className="ij-btn shrink-0 px-2"
                    title="Remove phase"
                    onClick={() => removePhase(phase.id)}
                    disabled={phases.length <= 1}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button className="ij-btn w-full" onClick={addPhase}>
                + Add phase
              </button>
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
            <button className="ij-btn mt-1 w-full" onClick={setScientificBaseline} disabled={activeIndex !== 0 || selection?.type !== "Line"}>
              Use selected line as height baseline
            </button>
            <div className="ij-sunken mt-2 space-y-1 p-2">
              {scientificRecipe?.groups.length ? scientificRecipe.groups.map((group) => (
                <div key={group.id} className="flex items-center justify-between gap-2 text-[10px]">
                  <span><strong>{group.name}</strong> · {group.role}</span>
                  <span className="ij-num">{group.components.length} component{group.components.length === 1 ? "" : "s"}</span>
                </div>
              )) : <span className="text-[10px] text-muted-foreground">No scientific phases captured yet.</span>}
              <div className="pt-1 text-[10px] text-muted-foreground">
                {scientificRecipe?.baseline ? "✓ Height baseline captured" : "No height baseline captured"}
              </div>
            </div>
            <button className="ij-btn mt-2 w-full" onClick={runScientificAll} disabled={!scientificRecipe?.groups.some((g) => g.role === "target") || !scientificRecipe?.baseline || isRunningAll}>
              {isRunningAll ? "Measuring sequence…" : "Run scientific measurement on all frames"}
            </button>
          </div>

          {showHistogram && (
            <div className="ij-raised">
              <div className="ij-title mb-3">Histogram</div>
              <HistogramView bins={bins} />
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function ScientificResults({ frames, activeIndex }: { frames: FrameState[]; activeIndex: number }) {
  const targetRows = frames.map((f, i) => ({
    frame: i + 1,
    name: f.name,
    result: f.scientific?.find((r) => r.role === "target"),
  }));
  const valid = targetRows.filter((r) => r.result?.heightPhysical != null);
  const maxH = Math.max(1, ...valid.map((r) => r.result?.heightPhysical ?? 0));
  const current = targetRows[activeIndex]?.result;
  return (
    <div className="mt-3 ij-sunken p-2">
      <div className="ij-title mb-2">Scientific drop height</div>
      <div className="grid grid-cols-4 gap-2 text-[10px]">
        <Kv k="Phase" v={current?.phase ?? "—"} />
        <Kv k="Height" v={current?.heightPhysical != null ? `${fmt(current.heightPhysical, 3)} mm` : "—"} />
        <Kv k="Contact Ø" v={current?.contactDiameterPhysical != null ? `${fmt(current.contactDiameterPhysical, 3)} mm` : "—"} />
        <Kv k="Status" v={current?.status ?? "—"} />
      </div>
      <div className="mt-2 h-[180px] overflow-hidden rounded border border-border bg-background p-1">
        {valid.length < 2 ? (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">
            Capture Water components + baseline, then run the scientific sequence.
          </div>
        ) : (
          <svg viewBox="0 0 900 170" className="h-full w-full" preserveAspectRatio="none">
            <line x1="35" y1="145" x2="890" y2="145" stroke="currentColor" opacity=".25" />
            <line x1="35" y1="15" x2="35" y2="145" stroke="currentColor" opacity=".25" />
            <polyline
              fill="none"
              stroke="#ff4d6d"
              strokeWidth="2.5"
              points={valid.map((r) => {
                const x = 35 + ((r.frame - 1) / Math.max(1, frames.length - 1)) * 855;
                const y = 145 - ((r.result?.heightPhysical ?? 0) / maxH) * 125;
                return `${x},${y}`;
              }).join(" ")}
            />
            {valid.map((r) => {
              const x = 35 + ((r.frame - 1) / Math.max(1, frames.length - 1)) * 855;
              const y = 145 - ((r.result?.heightPhysical ?? 0) / maxH) * 125;
              return <circle key={r.frame} cx={x} cy={y} r={3} fill="#ff4d6d" />;
            })}
            <text x="40" y="12" fontSize="10" fill="currentColor">Height ({valid[0]?.result?.heightPhysical != null ? "mm" : "px"})</text>
            <text x="820" y="163" fontSize="10" fill="currentColor">Frame</text>
          </svg>
        )}
      </div>
      <div className="mt-2 max-h-[150px] overflow-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead><tr><th className="text-left">Frame</th><th className="text-left">Height</th><th className="text-left">Contact Ø</th><th className="text-left">Components</th><th className="text-left">Status</th></tr></thead>
          <tbody>
            {targetRows.map((row) => (
              <tr key={row.frame} className={row.frame - 1 === activeIndex ? "bg-primary/10" : ""}>
                <td>{row.frame} · {row.name}</td>
                <td>{row.result?.heightPhysical != null ? `${fmt(row.result.heightPhysical, 3)} mm` : "—"}</td>
                <td>{row.result?.contactDiameterPhysical != null ? `${fmt(row.result.contactDiameterPhysical, 3)} mm` : "—"}</td>
                <td>{row.result?.componentCount ?? "—"}</td>
                <td>{row.result?.status ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
