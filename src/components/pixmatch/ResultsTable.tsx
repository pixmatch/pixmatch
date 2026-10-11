import { resultRows, type FrameState } from "@/lib/pixmatch";

const COLS: [keyof ReturnType<typeof resultRows>[number], string][] = [
  ["index", "#"],
  ["label", "Label"],
  ["type", "Type"],
  ["source", "Mode"],
  ["length", "Length/Feret"],
  ["minFeret", "Min Feret"],
  ["area", "Area"],
  ["perimeter", "Perim."],
  ["angle", "Angle"],
  ["circularity", "Circ."],
  ["lab", "L* a* b*"],
  ["deltaE", "ΔE"],
];

export function ResultsTable({
  frame,
  onDelete,
}: {
  frame: FrameState | undefined;
  onDelete: (id: string) => void;
}) {
  if (!frame) return <Empty text="No frame selected." />;
  const rows = resultRows(frame);
  if (!rows.length) return <Empty text="No measurements yet. Draw one, or run detection." />;

  return (
    <div className="ij-sunken max-h-[190px] overflow-auto">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-secondary">
          <tr>
            {COLS.map(([, title]) => (
              <th
                key={title}
                className="border-b border-border px-1.5 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-muted-foreground"
              >
                {title}
              </th>
            ))}
            <th className="border-b border-border px-1.5 py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={frame.measurements[i].id} className={i % 2 ? "bg-muted/50" : ""}>
              {COLS.map(([key]) => (
                <td key={String(key)} className="ij-num whitespace-nowrap px-1.5 py-[3px]">
                  {String(row[key])}
                </td>
              ))}
              <td className="px-1.5 py-[3px]">
                <button
                  className="text-[10px] text-destructive hover:underline"
                  onClick={() => onDelete(frame.measurements[i].id)}
                >
                  del
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="ij-sunken px-3 py-6 text-center text-[11px] text-muted-foreground">
      {text}
    </div>
  );
}
