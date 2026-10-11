import { useEffect, useRef } from "react";

export function HistogramView({ bins }: { bins: Uint32Array | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

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
  }, [bins]);

  return (
    <div className="ij-sunken p-1">
      <canvas ref={ref} className="block h-[80px] w-full" style={{ imageRendering: "pixelated" }} />
      <div className="mt-1 flex justify-between px-0.5 text-[9px] text-muted-foreground">
        <span>0</span>
        <span>gray value</span>
        <span>255</span>
      </div>
    </div>
  );
}
