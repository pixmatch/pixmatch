import { useMemo, useState } from "react";
import { NEEDLE_GAUGES, UNITS, mmTo, type Unit } from "@/lib/needle-gauge";
import { fmt, type Scale } from "@/lib/pixmatch";

type Props = {
  scale: Scale;
  onScaleChange: (scale: Scale) => void;
  calibrationPx: number | null;
  onPickCalibrationTool: (instruction: string) => void;
  disabled: boolean;
};

export function CalibrationPanel({ scale, onScaleChange, calibrationPx, onPickCalibrationTool, disabled }: Props) {
  const [mode, setMode] = useState<"needle" | "known">("needle");
  const [gauge, setGauge] = useState("21 G");
  const [edge, setEdge] = useState<"od" | "id">("od");
  const [known, setKnown] = useState("1.0");
  const [unit, setUnit] = useState<Unit>(scale.unit);
  const [pixelMode, setPixelMode] = useState<"draw" | "manual">("draw");
  const [manualPx, setManualPx] = useState("");

  const selected = NEEDLE_GAUGES.find((item) => item.gauge === gauge) ?? NEEDLE_GAUGES[0];
  const referenceValue = useMemo(() => {
    if (!selected) return 0;
    if (mode === "needle") return mmTo(edge === "od" ? selected.od : selected.id, unit);
    const value = Number(known);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [mode, edge, selected, unit, known]);
  const enteredPx = Number(manualPx);
  const effectivePx = pixelMode === "manual" && Number.isFinite(enteredPx) && enteredPx > 0 ? enteredPx : pixelMode === "draw" ? calibrationPx ?? 0 : 0;
  const candidate = effectivePx > 0 && referenceValue > 0 ? effectivePx / referenceValue : 0;
  const instruction = referenceValue > 0 ? `Draw the ${fmt(referenceValue)} ${unit} reference line now.` : "Enter the known distance first.";

  function apply() {
    if (!candidate) return;
    onScaleChange({
      pxPerUnit: candidate,
      unit,
      origin: mode === "needle" ? "needle" : "known-distance",
      note: mode === "needle" ? `${gauge} ${edge.toUpperCase()} = ${fmt(referenceValue)} ${unit}` : `${fmt(referenceValue)} ${unit} reference`,
    });
  }

  const dialRatio = selected ? selected.id / selected.od : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        {(["needle", "known"] as const).map((item) => (
          <button key={item} className="ij-btn flex-1" data-active={mode === item} onClick={() => setMode(item)}>
            {item === "needle" ? "Needle gauge" : "Known distance"}
          </button>
        ))}
      </div>

      {mode === "needle" && selected ? (
        <div className="flex items-center gap-3">
          <div className="ij-sunken flex h-[86px] w-[86px] shrink-0 items-center justify-center bg-canvas">
            <svg viewBox="0 0 80 80" className="h-[76px] w-[76px]">
              <circle cx="40" cy="40" r="34" fill="none" stroke="var(--overlay-grid)" strokeWidth="1" />
              <circle cx="40" cy="40" r="30" fill="var(--calibration)" opacity="0.9" />
              <circle cx="40" cy="40" r={Math.max(2, 30 * dialRatio)} fill="var(--canvas-bg)" />
              <line x1="4" y1="40" x2="76" y2="40" stroke="var(--measure)" strokeWidth="1" strokeDasharray="3 3" />
              <text x="40" y="74" textAnchor="middle" fontSize="9" fill="var(--measure)" fontFamily="var(--font-mono)">{gauge}</text>
            </svg>
          </div>
          <div className="flex-1 space-y-1.5">
            <label className="ij-title block">1 · Known gauge</label>
            <select className="ij-field" value={gauge} onChange={(event) => setGauge(event.target.value)}>
              {NEEDLE_GAUGES.map((item) => <option key={item.gauge} value={item.gauge}>{item.gauge} — OD {item.od} mm / ID {item.id} mm</option>)}
            </select>
            <div className="flex gap-1">
              {(["od", "id"] as const).map((item) => <button key={item} className="ij-btn flex-1" data-active={edge === item} onClick={() => setEdge(item)}>{item === "od" ? "Outer Ø" : "Inner Ø"}</button>)}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <label className="ij-title block">1 · Enter known distance</label>
          <div className="mt-1 grid grid-cols-[1fr_86px] gap-2">
            <input className="ij-field" aria-label="Known distance" type="number" min="0" step="0.001" value={known} onChange={(event) => setKnown(event.target.value)} />
            <select className="ij-field" aria-label="Distance unit" value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>
              {UNITS.filter((item) => item !== "px").map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>
        </div>
      )}

      {mode === "needle" && <div><label className="ij-title block">Unit</label><select className="ij-field mt-1" value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>{UNITS.filter((item) => item !== "px").map((item) => <option key={item}>{item}</option>)}</select></div>}

      <div className="calibration-callout">
        <span className="ij-title">2 · Pixel length</span>
        <strong>{pixelMode === "draw" ? instruction : "Enter the known pixel count."}</strong>
      </div>
      <div className="flex gap-1">
        <button className="ij-btn flex-1" data-active={pixelMode === "draw"} onClick={() => setPixelMode("draw")}>Draw line</button>
        <button className="ij-btn flex-1" data-active={pixelMode === "manual"} onClick={() => setPixelMode("manual")}>Enter pixels</button>
      </div>
      {pixelMode === "manual" ? (
        <div><label className="ij-title block">Pixel count</label><input className="ij-field mt-1" aria-label="Pixel count" type="number" min="0" step="0.1" placeholder="e.g. 248.5" value={manualPx} onChange={(event) => setManualPx(event.target.value)} /></div>
      ) : (
        <button className="ij-btn" onClick={() => onPickCalibrationTool(instruction)} disabled={disabled || referenceValue <= 0}>Draw {fmt(referenceValue)} {unit} line</button>
      )}

      <div className="ij-sunken space-y-1 p-2">
        <Row label="Known distance" value={referenceValue ? `${fmt(referenceValue)} ${unit}` : "enter first"} />
        <Row label="Pixel length" value={effectivePx ? `${fmt(effectivePx, 1)} px` : pixelMode === "draw" ? "draw line next" : "enter pixels"} />
        <Row label="Candidate scale" value={candidate ? `${fmt(candidate, 3)} px/${unit}` : "—"} />
        <Row label="Active scale" value={scale.pxPerUnit ? `${fmt(scale.pxPerUnit, 3)} px/${scale.unit}` : "uncalibrated"} />
      </div>

      <div className="flex gap-1">
        <button className="ij-btn flex-1" onClick={apply} disabled={!candidate}>Set scale</button>
        <button className="ij-btn" onClick={() => onScaleChange({ pxPerUnit: 0, unit, origin: "none", note: "uncalibrated" })}>Reset</button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between gap-2"><span className="text-[10px] uppercase text-muted-foreground">{label}</span><span className="ij-num truncate">{value}</span></div>;
}
