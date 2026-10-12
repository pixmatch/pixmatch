import { useEffect, useMemo, useRef, useState } from "react";
import { download, fmt, type Scale } from "@/lib/pixmatch";
import { mmPerPixelFromScale } from "@/scientific/calibration/calibration";
import { imageToLab, labToRgb } from "@/scientific/color/rgbToLab";
import { extractBoundary } from "@/scientific/geometry/boundary";
import { processFrame } from "@/scientific/execution/processFrame";
import { buildHeightRecipe, ENGINE_VERSION, type HeightRecipeOptions } from "@/scientific/execution/recipeBuilder";
import { exportAuditJSON, exportCSV, exportJSON } from "@/scientific/export/export";
import { medianL } from "@/scientific/segmentation/segmentFrame";
import { runScientificSelfCheck, type SelfCheckItem } from "@/scientific/validation/referenceTests";
import type { ExperimentResult, ImageFrame, Lab, MeasurementConvention, MeasurementResult } from "@/scientific/types";

type Pt = { x: number; y: number };

type Props = {
  frames: { id: string; name: string }[];
  activeIndex: number;
  /** Scale of the calibrated frame (pixels per unit); the engine converts it to mm/pixel. */
  scale: Scale;
  /** Decoded pixels of frame `index` (the app's own cache). */
  loadFrameImage: (index: number) => Promise<ImageData | null>;
  /** Last colour read with the Point tool (CIELAB). */
  probeLab: { L: number; a: number; b: number } | null;
  /** Mean colour of the last Wand region (CIELAB). */
  regionLab: { L: number; a: number; b: number } | null;
  /** Points of the selected line, used to set a baseline row. */
  selectedLine: Pt[] | null;
  onSelectFrame: (index: number) => void;
  onResult: (result: ExperimentResult | null) => void;
  setStatus: (message: string) => void;
};

const STATUS_COLOR: Record<string, string> = {
  VALID: "#3fb950", LOW_CONFIDENCE: "#d29922", INTERPOLATED: "#58a6ff",
  MISSING_PHASE: "#f85149", INVALID_FRAME: "#8b949e", SEGMENTATION_FAILED: "#f85149",
};

const num = (s: string): number | null => {
  const v = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(v) ? v : null;
};

/** Copy so the app's cached ImageData is never detached when the buffer is transferred to the worker. */
function toEngineFrame(index: number, name: string, img: ImageData): ImageFrame {
  return { frameIndex: index, name, width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function PipelinePanel({ frames, activeIndex, scale, loadFrameImage, probeLab, regionLab, selectedLine, onSelectFrame, onResult, setStatus }: Props) {
  // ---- reference phase colour
  const [L, setL] = useState(""); const [A, setA] = useState(""); const [B, setB] = useState("");
  const [refSource, setRefSource] = useState("not set");
  const [refIndex, setRefIndex] = useState(0);
  const [deltaE, setDeltaE] = useState("8");
  // ---- cleanup
  const [openR, setOpenR] = useState("1");
  const [closeR, setCloseR] = useState("2");
  const [fillHoles, setFillHoles] = useState(true);
  const [minArea, setMinArea] = useState("50");
  const [largestOnly, setLargestOnly] = useState(true);
  const [trim, setTrim] = useState("0");
  const [illum, setIllum] = useState(false);
  // ---- measurement
  const [convention, setConvention] = useState<MeasurementConvention>("INCLUSIVE_PIXEL");
  const [baseline, setBaseline] = useState("");
  const [mmOverride, setMmOverride] = useState("");
  const [scaleSigma, setScaleSigma] = useState("");
  const [interpolate, setInterpolate] = useState(false);
  const [minConf, setMinConf] = useState("0.6");
  // ---- run state
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [resultKey, setResultKey] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [mode, setMode] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const medianCache = useRef<{ key: string; value: number } | null>(null);
  // ---- preview
  const [live, setLive] = useState(true);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewInfo, setPreviewInfo] = useState<MeasurementResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selfCheck, setSelfCheck] = useState<{ ok: boolean; items: SelfCheckItem[] } | null>(null);

  useEffect(() => { setPreviewIndex(Math.min(Math.max(activeIndex, 0), Math.max(frames.length - 1, 0))); }, [activeIndex, frames.length]);

  // ---- derived settings
  const scaleMm = mmPerPixelFromScale(scale.pxPerUnit, scale.unit);
  const mmPerPixel = num(mmOverride) ?? scaleMm;
  const refLab: Lab | null = (() => { const l = num(L), a = num(A), b = num(B); return l != null && a != null && b != null ? [l, a, b] : null; })();
  const dE = num(deltaE);
  const problems: string[] = [];
  if (!frames.length) problems.push("Open an image sequence.");
  if (!refLab) problems.push("Set the phase colour (probe or wand region below).");
  if (dE == null || dE <= 0) problems.push("ΔE tolerance must be above 0.");
  if (!mmPerPixel || mmPerPixel <= 0) problems.push("No physical scale: calibrate with the needle gauge or enter mm per pixel.");
  const ready = problems.length === 0;

  const options = (targetMedianL: number | null): HeightRecipeOptions | null => {
    if (!refLab || dE == null || dE <= 0 || !mmPerPixel || mmPerPixel <= 0) return null;
    return {
      referenceLab: refLab, deltaE: dE, mmPerPixel, uncertaintyMmPerPixel: num(scaleSigma) ?? 0, convention,
      baselineY: num(baseline), openingRadius: Math.max(0, Math.round(num(openR) ?? 0)), closingRadius: Math.max(0, Math.round(num(closeR) ?? 0)),
      fillHoles, minimumAreaPixels: Math.max(1, Math.round(num(minArea) ?? 1)), keepLargestOnly: largestOnly,
      trimPercent: Math.min(10, Math.max(0, num(trim) ?? 0)), targetMedianL: illum ? targetMedianL : null,
      allowInterpolation: interpolate, minimumConfidence: Math.min(1, Math.max(0, num(minConf) ?? 0.6)),
    };
  };
  const cfgKey = JSON.stringify({ L, A, B, deltaE, openR, closeR, fillHoles, minArea, largestOnly, trim, illum, convention, baseline, mmPerPixel, scaleSigma, interpolate, minConf, refIndex });

  async function referenceMedianL(): Promise<number | null> {
    const img = await loadFrameImage(refIndex);
    if (!img) return null;
    const key = `${refIndex}:${img.width}x${img.height}`;
    if (medianCache.current?.key === key) return medianCache.current.value;
    const lab = imageToLab({ width: img.width, height: img.height, data: img.data });
    const value = medianL(lab, img.width, img.height);
    medianCache.current = { key, value };
    return value;
  }

  // ---- live preview of one frame (same engine code as the batch)
  useEffect(() => {
    if (!live || !ready || !frames[previewIndex]) { setPreviewInfo(null); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setPreviewBusy(true);
        const img = await loadFrameImage(previewIndex);
        if (!img || cancelled) return;
        const target = illum ? await referenceMedianL() : null;
        const opts = options(target);
        if (!opts || cancelled) return;
        const recipe = { ...buildHeightRecipe(opts), preserveMasks: true };
        const frame = toEngineFrame(previewIndex, frames[previewIndex].name, img);
        const out = processFrame(frame, recipe);
        if (cancelled) return;
        setPreviewInfo(out.results[0] ?? null);
        const mask = out.masks?.["height"];
        if (canvasRef.current) drawPreview(canvasRef.current, img, mask?.data ?? null, out.results[0] ?? null);
      } catch (e) {
        if (!cancelled) setStatus(`Preview failed: ${String((e as Error).message ?? e)}`);
      } finally { if (!cancelled) setPreviewBusy(false); }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ready, previewIndex, cfgKey, frames.length]);

  function adoptColour(lab: { L: number; a: number; b: number } | null, source: string) {
    if (!lab) return;
    setL(lab.L.toFixed(2)); setA(lab.a.toFixed(2)); setB(lab.b.toFixed(2));
    setRefSource(source); setRefIndex(activeIndex); setPreviewIndex(activeIndex);
    setStatus(`Phase colour set from ${source} on frame ${activeIndex + 1}: L*a*b* ${lab.L.toFixed(1)}, ${lab.a.toFixed(1)}, ${lab.b.toFixed(1)}.`);
  }

  async function run() {
    if (!ready || running) return;
    setError(null); setRunning(true); cancelRef.current = false; setProgress({ done: 0, total: frames.length });
    let runner: Awaited<ReturnType<typeof import("@/scientific/worker/client").createRunner>> | null = null;
    try {
      const target = illum ? await referenceMedianL() : null;
      const opts = options(target);
      if (!opts) throw new Error("INVALID_SETTINGS");
      const recipe = buildHeightRecipe(opts);
      const { createRunner } = await import("@/scientific/worker/client");
      runner = await createRunner(`pixmatch-${Date.now()}`, recipe);
      setMode(runner.mode === "worker" ? "background thread" : "main thread");
      for (let i = 0; i < frames.length; i++) {
        if (cancelRef.current) throw new Error("CANCELLED");
        const img = await loadFrameImage(i);
        if (!img) throw new Error(`Could not read frame ${i + 1}`);
        await runner.processFrame(toEngineFrame(i, frames[i].name, img));
        setProgress({ done: i + 1, total: frames.length });
        setStatus(`Pipeline ${i + 1}/${frames.length}: ${frames[i].name}`);
      }
      const done = await runner.finish();
      setResult(done); setResultKey(cfgKey); onResult(done);
      const bad = done.results.filter((r) => r.status !== "VALID").length;
      setStatus(bad ? `Pipeline finished: ${done.results.length - bad} valid, ${bad} need review.` : `Pipeline finished: all ${done.results.length} frames valid.`);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      if (message === "CANCELLED") setStatus("Pipeline cancelled.");
      else { setError(explain(message)); setStatus(`Pipeline stopped: ${explain(message)}`); }
    } finally {
      runner?.dispose(); setRunning(false); setProgress(null);
    }
  }

  const stale = result != null && resultKey !== cfgKey;
  const rows = result?.results ?? [];
  const swatch = refLab ? `rgb(${labToRgb(refLab).join(",")})` : "transparent";

  return (
    <div id="pixmatch-pipeline" className="flex flex-col gap-2">
      <p className="text-[10px] text-muted-foreground">
        Engine {ENGINE_VERSION}: ImageData → CIELAB → CIEDE2000 phase mask → cleanup → components → boundary → pixel height → mm → confidence + uncertainty → audit.
        Every frame is measured independently.
      </p>

      {/* 1. phase colour */}
      <div className="ij-sunken space-y-1 p-2">
        <div className="ij-title">1 · Phase colour (CIELAB)</div>
        <div className="grid grid-cols-[auto_1fr_1fr_1fr] items-center gap-1">
          <span className="h-6 w-6 rounded border border-white/20" style={{ background: swatch }} title="Colour of the phase" />
          {[["L*", L, setL], ["a*", A, setA], ["b*", B, setB]].map(([label, value, setter]) => (
            <input key={label as string} className="ij-field ij-num" placeholder={label as string} value={value as string}
              onChange={(e) => { (setter as (v: string) => void)(e.target.value); setRefSource("typed"); }} aria-label={label as string} />
          ))}
        </div>
        <div className="flex gap-1">
          <button className="ij-btn flex-1" disabled={!probeLab} onClick={() => adoptColour(probeLab, "Point probe")}
            title="Use the Point tool on the phase first, then press this">Use probed colour</button>
          <button className="ij-btn flex-1" disabled={!regionLab} onClick={() => adoptColour(regionLab, "Wand region mean")}
            title="Use the Wand tool on the phase first, then press this">Use wand region</button>
        </div>
        <p className="ij-num text-[10px] text-muted-foreground">Source: {refSource}{refLab ? ` · frame ${refIndex + 1}` : ""}</p>
        <label className="flex items-center gap-2 text-[11px]">ΔE₀₀ tolerance
          <input className="ij-field ij-num w-16" value={deltaE} onChange={(e) => setDeltaE(e.target.value)} />
        </label>
      </div>

      {/* 2. cleanup */}
      <div className="ij-sunken space-y-1 p-2">
        <div className="ij-title">2 · Mask cleanup</div>
        <div className="grid grid-cols-3 gap-1 text-[11px]">
          <label>Open (px)<input className="ij-field ij-num mt-0.5" value={openR} onChange={(e) => setOpenR(e.target.value)} /></label>
          <label>Close (px)<input className="ij-field ij-num mt-0.5" value={closeR} onChange={(e) => setCloseR(e.target.value)} /></label>
          <label>Min area (px)<input className="ij-field ij-num mt-0.5" value={minArea} onChange={(e) => setMinArea(e.target.value)} /></label>
        </div>
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={fillHoles} onChange={(e) => setFillHoles(e.target.checked)} />Fill interior holes</label>
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={largestOnly} onChange={(e) => setLargestOnly(e.target.checked)} />Keep only the largest connected region</label>
        <label className="flex items-center gap-2 text-[11px]">Trim edge outliers (% of pixels per end)
          <input className="ij-field ij-num w-14" value={trim} onChange={(e) => setTrim(e.target.value)} /></label>
        <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={illum} onChange={(e) => setIllum(e.target.checked)} />Match exposure to the reference frame (small drifts only)</label>
      </div>

      {/* 3. measurement + calibration */}
      <div className="ij-sunken space-y-1 p-2">
        <div className="ij-title">3 · Height & calibration</div>
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          <label>Pixel convention
            <select className="ij-field mt-0.5" value={convention} onChange={(e) => setConvention(e.target.value as MeasurementConvention)}>
              <option value="INCLUSIVE_PIXEL">Inclusive (max−min+1)</option>
              <option value="PIXEL_CENTER">Pixel centre (max−min)</option>
            </select>
          </label>
          <label>Baseline row (optional)
            <input className="ij-field ij-num mt-0.5" placeholder="bottom of phase" value={baseline} onChange={(e) => setBaseline(e.target.value)} />
          </label>
        </div>
        <div className="flex gap-1">
          <button className="ij-btn flex-1" disabled={!selectedLine || selectedLine.length < 2}
            onClick={() => selectedLine && setBaseline(String(Math.round((selectedLine[0].y + selectedLine[selectedLine.length - 1].y) / 2)))}>Baseline = selected line</button>
          <button className="ij-btn" onClick={() => setBaseline("")} disabled={!baseline}>Clear</button>
        </div>
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          <label>mm per pixel
            <input className="ij-field ij-num mt-0.5" placeholder={scaleMm ? fmt(scaleMm, 5) : "calibrate first"} value={mmOverride} onChange={(e) => setMmOverride(e.target.value)} />
          </label>
          <label>Scale ±σ (mm/px)
            <input className="ij-field ij-num mt-0.5" placeholder="0" value={scaleSigma} onChange={(e) => setScaleSigma(e.target.value)} />
          </label>
        </div>
        <p className="ij-num text-[10px] text-muted-foreground">
          {mmPerPixel ? `Using ${fmt(mmPerPixel, 5)} mm/px${num(mmOverride) ? " (typed)" : ` (from ${scale.origin} calibration)`}` : "No scale yet — physical heights stay off until you set one."}
        </p>
        <div className="grid grid-cols-2 gap-1 text-[11px]">
          <label>Low-confidence below
            <input className="ij-field ij-num mt-0.5" value={minConf} onChange={(e) => setMinConf(e.target.value)} /></label>
          <label className="flex items-end gap-2 pb-1"><input type="checkbox" checked={interpolate} onChange={(e) => setInterpolate(e.target.checked)} />Fill gaps by interpolation</label>
        </div>
      </div>

      {/* preview */}
      <div className="ij-sunken space-y-1 p-2">
        <div className="flex items-center justify-between">
          <div className="ij-title">Live preview (same engine code)</div>
          <label className="flex items-center gap-1 text-[10px]"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />on</label>
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <button className="ij-btn" disabled={previewIndex <= 0} onClick={() => setPreviewIndex(previewIndex - 1)}>◀</button>
          <span className="ij-num flex-1 truncate text-center">{frames[previewIndex] ? `${previewIndex + 1}/${frames.length} · ${frames[previewIndex].name}` : "—"}</span>
          <button className="ij-btn" disabled={previewIndex >= frames.length - 1} onClick={() => setPreviewIndex(previewIndex + 1)}>▶</button>
        </div>
        {live && ready ? (
          <>
            <canvas ref={canvasRef} className="w-full rounded border border-white/10" style={{ opacity: previewBusy ? 0.6 : 1 }} />
            {previewInfo && (
              <p className="ij-num text-[10px]">
                <span style={{ color: STATUS_COLOR[previewInfo.status] }}>{previewInfo.status}</span>
                {previewInfo.pixelHeight != null && ` · ${fmt(previewInfo.pixelHeight, 1)} px`}
                {previewInfo.physicalHeightMm != null && ` · ${fmt(previewInfo.physicalHeightMm, 4)} mm`}
                {` · conf ${fmt(previewInfo.confidence, 2)}`}
                {previewInfo.notes?.length ? ` · ${previewInfo.notes.join(", ")}` : ""}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground">Red = phase mask, yellow = extracted boundary, cyan = top and bottom used for the height.</p>
          </>
        ) : (
          <p className="text-[10px] text-muted-foreground">{ready ? "Preview is off." : "Finish steps 1–3 to see the mask on the image."}</p>
        )}
      </div>

      {/* run */}
      {problems.length > 0 && <ul className="ij-num list-disc pl-4 text-[10px] text-amber-300">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {error && <p className="ij-num text-[10px] text-red-400">{error}</p>}
      <div className="flex gap-1">
        <button className="ij-btn flex-1" data-active={running} disabled={!ready || running} onClick={run}>
          {running && progress ? `Running ${progress.done}/${progress.total}…` : `Run pipeline on ${frames.length} frame${frames.length === 1 ? "" : "s"}`}
        </button>
        {running && <button className="ij-btn" onClick={() => { cancelRef.current = true; }}>Cancel</button>}
      </div>
      {mode && !running && result && <p className="ij-num text-[10px] text-muted-foreground">Ran on the {mode}.</p>}

      {/* results */}
      {result && (
        <div className="space-y-1">
          {stale && <p className="ij-num text-[10px] text-amber-300">Settings changed since this run — run again to update the table and exports.</p>}
          <Summary result={result} />
          <HeightChart rows={rows} />
          <div className="ij-sunken max-h-[220px] overflow-auto">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-[#0b1626]"><tr className="text-left">
                <th className="px-1">#</th><th>Status</th><th>px</th><th>mm</th><th>±mm</th><th>conf</th><th>area</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.frameIndex} className="ij-num cursor-pointer hover:bg-white/5" onClick={() => { setPreviewIndex(r.frameIndex); onSelectFrame(r.frameIndex); }}
                    title={r.notes?.join(", ") ?? r.frameName}>
                    <td className="px-1">{r.frameIndex + 1}</td>
                    <td style={{ color: STATUS_COLOR[r.status] }}>{r.status.replace("_", " ")}</td>
                    <td>{r.pixelHeight == null ? "—" : fmt(r.pixelHeight, 1)}</td>
                    <td>{r.physicalHeightMm == null ? "—" : fmt(r.physicalHeightMm, 4)}</td>
                    <td>{r.uncertainty ? fmt(r.uncertainty.combinedUncertaintyMm, 4) : "—"}</td>
                    <td>{fmt(r.confidence, 2)}</td>
                    <td>{r.areaPixels ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.audit.warnings && result.audit.warnings.length > 0 && (
            <ul className="ij-num list-disc pl-4 text-[10px] text-amber-300">{result.audit.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
          <div className="flex gap-1">
            <button className="ij-btn flex-1" onClick={() => download("pixmatch-pipeline.csv", exportCSV(result), "text/csv;charset=utf-8")}>CSV</button>
            <button className="ij-btn flex-1" onClick={() => download("pixmatch-pipeline.json", exportJSON(result), "application/json")}>JSON</button>
            <button className="ij-btn flex-1" onClick={() => download("pixmatch-pipeline-audit.json", exportAuditJSON(result), "application/json")}>Audit</button>
          </div>
        </div>
      )}

      <button className="ij-btn" onClick={() => setSelfCheck(runScientificSelfCheck())}>Run engine self-check</button>
      {selfCheck && (
        <div className="ij-sunken max-h-[160px] overflow-auto p-2">
          <div className="ij-title" style={{ color: selfCheck.ok ? "#3fb950" : "#f85149" }}>
            {selfCheck.ok ? "All checks passed" : "Some checks failed"} ({selfCheck.items.filter((i) => i.ok).length}/{selfCheck.items.length})
          </div>
          <ul className="ij-num text-[10px]">
            {selfCheck.items.map((i) => <li key={i.name} style={{ color: i.ok ? undefined : "#f85149" }}>{i.ok ? "✓" : "✗"} {i.name} — {i.detail}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function explain(message: string): string {
  if (message.startsWith("INVALID_CALIBRATION")) return "The mm/pixel scale is missing or not above zero.";
  if (message.startsWith("INVALID_DELTA_E")) return "ΔE tolerance must be above zero.";
  if (message.startsWith("INVALID_REFERENCE")) return "The phase colour is not a valid L*a*b* value.";
  if (message.startsWith("UNSUPPORTED_QUANTITY")) return "Only height is supported by this pipeline.";
  return message;
}

function Summary({ result }: { result: ExperimentResult }) {
  const a = result.audit;
  const counts = a.statusCounts ?? {};
  return (
    <p className="ij-num text-[10px]">
      {a.frameCount} frames ·{" "}
      {Object.entries(counts).map(([k, v], i) => (
        <span key={k} style={{ color: STATUS_COLOR[k] }}>{i ? ", " : ""}{v} {k.toLowerCase().replace("_", " ")}</span>
      ))}
      {" · "}{fmt(a.calibration.mmPerPixel, 5)} mm/px · {a.algorithmVersion}
    </p>
  );
}

function HeightChart({ rows }: { rows: MeasurementResult[] }) {
  const pts = rows.filter((r) => r.physicalHeightMm != null);
  if (pts.length < 2) return null;
  const W = 300, H = 90, pad = 22;
  const xs = rows.map((r) => r.frameIndex);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ys = pts.map((r) => r.physicalHeightMm as number);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (x: number) => pad + ((x - x0) / Math.max(1e-9, x1 - x0)) * (W - pad - 6);
  const sy = (y: number) => H - 14 - ((y - y0) / Math.max(1e-9, y1 - y0)) * (H - 24);
  const line = pts.map((r) => `${sx(r.frameIndex).toFixed(1)},${sy(r.physicalHeightMm as number).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-white/10 bg-black/20" role="img" aria-label="Height versus frame">
      <polyline points={line} fill="none" stroke="#58a6ff" strokeWidth={1} />
      {pts.map((r) => <circle key={r.frameIndex} cx={sx(r.frameIndex)} cy={sy(r.physicalHeightMm as number)} r={2.2} fill={STATUS_COLOR[r.status] ?? "#8b949e"} />)}
      <text x={2} y={10} fontSize={8} fill="#8b949e">{fmt(y1, 3)} mm</text>
      <text x={2} y={H - 4} fontSize={8} fill="#8b949e">{fmt(y0, 3)}</text>
      <text x={W - 6} y={H - 2} fontSize={8} fill="#8b949e" textAnchor="end">frame {x1 + 1}</text>
    </svg>
  );
}

/** Draw the frame with the phase mask (red), its extracted boundary (yellow) and the two rows used for the height (cyan). */
function drawPreview(canvas: HTMLCanvasElement, img: ImageData, mask: Uint8Array | null, result: MeasurementResult | null) {
  const maxW = 320;
  const s = Math.min(1, maxW / img.width);
  canvas.width = Math.max(1, Math.round(img.width * s));
  canvas.height = Math.max(1, Math.round(img.height * s));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const base = document.createElement("canvas");
  base.width = img.width; base.height = img.height;
  base.getContext("2d")!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
  if (mask) {
    const edge = extractBoundary({ width: img.width, height: img.height, data: mask }).edge;
    const ov = new ImageData(img.width, img.height);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const p = i * 4;
      if (edge[i]) { ov.data[p] = 255; ov.data[p + 1] = 220; ov.data[p + 2] = 0; ov.data[p + 3] = 255; }
      else { ov.data[p] = 255; ov.data[p + 1] = 50; ov.data[p + 2] = 80; ov.data[p + 3] = 110; }
    }
    const layer = document.createElement("canvas");
    layer.width = img.width; layer.height = img.height;
    layer.getContext("2d")!.putImageData(ov, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
  }
  if (result && result.minY != null && result.maxY != null) {
    ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1;
    const line = (y: number, dash: number[]) => { ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(0, (y + 0.5) * s); ctx.lineTo(canvas.width, (y + 0.5) * s); ctx.stroke(); };
    line(result.minY, []);
    line(result.baselineY ?? result.maxY, result.baselineY != null ? [4, 3] : []);
    ctx.setLineDash([]);
  }
}
