import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { CHANNELS, type ChannelId, type ChannelLimits } from "@/lib/segmentation";

type Props = {
  bins: Uint32Array | null;
  channel: ChannelId;
  onChannel: (channel: ChannelId) => void;
  limits: ChannelLimits | null | undefined;
  onLimits: (next: ChannelLimits | null) => void;
  /** True when a traced region is selected, so its colour range can be turned into limits. */
  canFit: boolean;
  onFit: () => void;
};

/**
 * Channel histogram that doubles as a detection input: L*, a*, b* and RGB windows are hard
 * limits applied on top of the fused colour distance in the wand and replayed phase model.
 */
export function HistogramView({ bins, channel, onChannel, limits, onLimits, canFit, onFit }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const info = CHANNELS[channel];
  const windowed = channel === "gray" ? undefined : limits?.[channel];

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = 256;
    canvas.height = 80;
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--canvas-bg") || "#222";
    ctx.fillRect(0, 0, 256, 80);
    if (!bins) return;
    const max = Math.max(...Array.from(bins));
    if (!max) return;
    const toBin = (v: number) => ((v - info.min) / (info.max - info.min)) * 255;
    if (windowed) {
      ctx.fillStyle = "rgba(59,130,246,.28)";
      const x0 = Math.max(0, toBin(windowed[0])), x1 = Math.min(255, toBin(windowed[1]));
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), 80);
    }
    ctx.fillStyle = "#cfd6d9";
    for (let i = 0; i < 256; i++) {
      const h = (bins[i] / max) * 78;
      ctx.fillRect(i, 80 - h, 1, h);
    }
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    for (let g = 0; g < 256; g += 64) {
      ctx.beginPath();
      ctx.moveTo(g, 0);
      ctx.lineTo(g, 80);
      ctx.stroke();
    }
    if (windowed) {
      ctx.strokeStyle = "#60a5fa";
      for (const v of windowed) {
        const x = Math.max(0, Math.min(255, toBin(v)));
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 80);
        ctx.stroke();
      }
    }
  }, [bins, windowed, info.min, info.max]);

  function setBound(which: 0 | 1, value: number) {
    if (channel === "gray") return;
    const cur = limits?.[channel] ?? [info.min, info.max];
    const next: [number, number] = which === 0 ? [value, cur[1]] : [cur[0], value];
    if (next[0] > next[1]) next.reverse();
    onLimits({ ...(limits ?? {}), [channel]: next });
  }

  function onClickCanvas(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (channel === "gray") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const v = info.min + ((event.clientX - rect.left) / rect.width) * (info.max - info.min);
    if (!windowed) {
      const span = (info.max - info.min) * 0.1;
      onLimits({ ...(limits ?? {}), [channel]: [v - span / 2, v + span / 2] });
      return;
    }
    setBound(Math.abs(v - windowed[0]) <= Math.abs(v - windowed[1]) ? 0 : 1, v);
  }

  const anyLimit = Boolean(limits && (limits.L || limits.a || limits.b || limits.R || limits.G || limits.B));

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {(Object.keys(CHANNELS) as ChannelId[]).map((id) => (
          <button key={id} className="ij-btn flex-1 px-1" data-active={channel === id} onClick={() => onChannel(id)}>
            {CHANNELS[id].label}{id !== "gray" && limits?.[id] ? " ●" : ""}
          </button>
        ))}
      </div>
      <div className="ij-sunken p-1">
        <canvas
          ref={ref}
          className="block h-[80px] w-full"
          style={{ imageRendering: "pixelated", cursor: channel === "gray" ? "default" : "crosshair" }}
          onClick={onClickCanvas}
        />
        <div className="mt-1 flex justify-between px-0.5 text-[9px] text-muted-foreground">
          <span>{info.min}</span>
          <span>{info.label}{channel === "gray" ? " value" : " · click to set a limit"}</span>
          <span>{info.max}</span>
        </div>
      </div>
      {channel !== "gray" && (
        <div className="grid grid-cols-2 gap-2">
          {([0, 1] as const).map((which) => (
            <label key={which} className="text-[10px]">
              <span className="ij-title block">{which === 0 ? "Min" : "Max"} {info.label}</span>
              <input
                className="ij-field mt-1 w-full"
                type="number"
                step={0.5}
                value={windowed ? Number(windowed[which].toFixed(1)) : ""}
                placeholder="off"
                onChange={(e) => {
                  if (e.target.value === "") return;
                  setBound(which, Number(e.target.value));
                }}
              />
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <button className="ij-btn flex-1" onClick={onFit} disabled={!canFit} title="Set CIELAB + RGB windows from the selected traced region">
          Fit to selected region
        </button>
        <button className="ij-btn flex-1" onClick={() => onLimits(null)} disabled={!anyLimit}>
          Clear limits
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Limits are extra hard windows on top of the fused CIELAB/RGB score. They are stored with each captured phase and applied on every frame.
      </p>
    </div>
  );
}
