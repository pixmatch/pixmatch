import type { PhaseMask } from '../types';

export interface Component { label: number; area: number; minX: number; maxX: number; minY: number; maxY: number; }
export interface Labelled { labels: Int32Array; components: Component[]; }

/** 4-connected component labelling. Labels start at 1; 0 = background. */
export function labelComponents(mask: PhaseMask): Labelled {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(data.length);
  const queue = new Int32Array(data.length);
  const components: Component[] = [];
  let label = 0;
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start]) continue;
    label++;
    let head = 0, tail = 0, area = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && data[p - 1] && !labels[p - 1]) { labels[p - 1] = label; queue[tail++] = p - 1; }
      if (x < w - 1 && data[p + 1] && !labels[p + 1]) { labels[p + 1] = label; queue[tail++] = p + 1; }
      if (y > 0 && data[p - w] && !labels[p - w]) { labels[p - w] = label; queue[tail++] = p - w; }
      if (y < h - 1 && data[p + w] && !labels[p + w]) { labels[p + w] = label; queue[tail++] = p + w; }
    }
    components.push({ label, area, minX, maxX, minY, maxY });
  }
  return { labels, components };
}
export function connectedComponents(mask: PhaseMask): Component[] { return labelComponents(mask).components; }

/** Keep components whose area is in [minArea, maxArea]; optionally only the single largest of those. */
export function filterComponents(mask: PhaseMask, minArea: number, maxArea?: number, keepLargestOnly = false): PhaseMask {
  const { labels, components } = labelComponents(mask);
  let kept = components.filter(c => c.area >= minArea && (maxArea == null || c.area <= maxArea));
  if (keepLargestOnly && kept.length > 1) {
    kept = [kept.reduce((best, c) => (c.area > best.area ? c : best))];
  }
  const keep = new Set(kept.map(c => c.label));
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i++) if (keep.has(labels[i])) out[i] = 1;
  return { width: mask.width, height: mask.height, data: out };
}
