import type { DetectOptions } from "@/lib/segmentation";
import { fmt, type Recipe } from "@/lib/pixmatch";

type Props = {
  detect: DetectOptions;
  onDetect: (next: DetectOptions) => void;
  searchRadius: number;
  onSearchRadius: (value: number) => void;
  mode: "manual" | "auto";
  onMode: (mode: "manual" | "auto") => void;
  recipe: Recipe | null;
  canCapture: boolean;
  onCapture: () => void;
  onRunFrame: () => void;
  onRunAll: () => void;
  onPickWand: () => void;
  isReference: boolean;
  autoNote: string;
  isRunningAll?: boolean;
};

/** CIELAB + RGB boundary detection controls + the manual/auto propagation switch. */
export function DetectPanel({
  detect,
  onDetect,
  searchRadius,
  onSearchRadius,
  mode,
  onMode,
  recipe,
  canCapture,
  onCapture,
  onRunFrame,
  onRunAll,
  onPickWand,
  isReference,
  autoNote,
  isRunningAll = false,
}: Props) {
  const set = <K extends keyof DetectOptions>(key: K, value: DetectOptions[K]) =>
    onDetect({ ...detect, [key]: value });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        {(["manual", "auto"] as const).map((m) => (
          <button
            key={m}
            className="ij-btn flex-1"
            data-active={mode === m}
            onClick={() => onMode(m)}
            disabled={isReference || (m === "auto" && !recipe)}
            title={m === "auto" && !recipe ? "Capture a recipe from image 1 first" : undefined}
          >
            {isReference && m === "manual" ? "Reference · Manual" : m === "manual" ? "Manual" : "Automatic"}
          </button>
        ))}
      </div>

      <Slider
        label="ΔE tolerance"
        value={detect.tolerance}
        min={1}
        max={60}
        step={0.5}
        onChange={(v) => set("tolerance", v)}
      />
      <Slider
        label="Seed patch (px)"
        value={detect.seedRadius}
        min={0}
        max={12}
        step={1}
        onChange={(v) => set("seedRadius", v)}
      />
      <Slider
        label="Lightness weight (L*)"
        value={detect.lightnessWeight ?? 1}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => set("lightnessWeight", v)}
      />
      <Slider
        label="RGB contribution"
        value={detect.rgbWeight ?? 0}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => set("rgbWeight", v)}
      />
      <Slider
        label="RGB tolerance (0–100)"
        value={detect.rgbTolerance ?? 18}
        min={1}
        max={60}
        step={1}
        onChange={(v) => set("rgbTolerance", v)}
      />
      <Slider
        label="Smoothing"
        value={detect.smooth}
        min={0}
        max={5}
        step={1}
        onChange={(v) => set("smooth", v)}
      />
      <Slider
        label="Auto search radius"
        value={searchRadius}
        min={0}
        max={160}
        step={4}
        onChange={onSearchRadius}
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="ij-title block">ΔE metric</label>
          <select
            className="ij-field mt-1"
            value={detect.metric}
            onChange={(e) => set("metric", e.target.value as DetectOptions["metric"])}
          >
            <option value="ciede2000">CIEDE2000</option>
            <option value="cie76">CIE76</option>
          </select>
        </div>
        <div>
          <label className="ij-title block">Connectivity</label>
          <select
            className="ij-field mt-1"
            value={detect.connectivity}
            onChange={(e) => set("connectivity", Number(e.target.value) as 4 | 8)}
          >
            <option value={8}>8-connected</option>
            <option value={4}>4-connected</option>
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={detect.fillHoles}
          onChange={(e) => set("fillHoles", e.target.checked)}
        />
        Fill interior holes
      </label>

      <button className="ij-btn" onClick={onPickWand}>
        Wand tool — click the phase to trace
      </button>

      <div className="ij-sunken space-y-1 p-2">
        <div className="ij-title">Recipe from reference frame</div>
        {recipe ? (
          <div className="space-y-0.5">
            <Line k="From" v={recipe.capturedFrom} />
            <Line k="Steps" v={String(recipe.steps.length)} />
            <Line k="Tools" v={recipe.steps.map((step) => step.type).join(" · ")} />
            {recipe.steps.find((step) => step.detect)?.detect && (
              <Line
                k="CIELAB"
                v={`ΔE ${fmt(recipe.steps.find((step) => step.detect)?.detect?.tolerance, 1)} · ${recipe.steps.find((step) => step.detect)?.detect?.metric}`}
              />
            )}
            <Line
              k="Scale"
              v={
                recipe.scale.pxPerUnit
                  ? `${fmt(recipe.scale.pxPerUnit, 2)} px/${recipe.scale.unit}`
                  : "uncalibrated"
              }
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Measure image 1 with any tools, then capture. Later images replay the
            ordered geometry and relocate colour-based regions automatically.
          </p>
        )}
      </div>

      <div className="flex gap-1">
        <button className="ij-btn flex-1" onClick={onCapture} disabled={!canCapture || !isReference}>
          Capture recipe
        </button>
        <button className="ij-btn flex-1" onClick={onRunFrame} disabled={!recipe || isReference}>
          Run frame
        </button>
        <button className="ij-btn flex-1" onClick={onRunAll} disabled={!recipe || isRunningAll}>
          {isRunningAll ? "Running…" : "Run all"}
        </button>
      </div>
      {autoNote && <p className="ij-num text-[10px] text-muted-foreground">{autoNote}</p>}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="ij-title">{label}</label>
        <span className="ij-num">{value}</span>
      </div>
      <input
        className="w-full accent-[var(--primary)]"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase text-muted-foreground">{k}</span>
      <span className="ij-num truncate">{v}</span>
    </div>
  );
}
