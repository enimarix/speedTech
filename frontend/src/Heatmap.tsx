import { Fragment } from "react";
import type { CellStat } from "./api";

// Grid heatmap on the car's own RPM×Load axes (§4/§9) — the same trick MLV uses. Cols = RPM,
// rows = Load (high load on top). Colour comes from the per-map colour function.
export function Heatmap({
  title, cells, rpmAxis, loadAxis, color, fmt = (v) => v.toFixed(1),
}: {
  title: string;
  cells: CellStat[];
  rpmAxis: number[];
  loadAxis: number[];
  color: (v: number) => string;
  fmt?: (v: number) => string;
}) {
  const by = new Map(cells.map((c) => [`${c.rpm_bin}|${c.load_bin}`, c]));
  const rows = [...loadAxis].reverse();
  return (
    <div className="heatmap">
      <h4>{title}</h4>
      <div className="grid" style={{ gridTemplateColumns: `48px repeat(${rpmAxis.length}, 1fr)` }}>
        <div className="corner" />
        {rpmAxis.map((r) => <div key={r} className="axis col">{r}</div>)}
        {rows.map((load) => (
          <Fragment key={load}>
            <div className="axis row">{load}</div>
            {rpmAxis.map((rpm) => {
              const c = by.get(`${rpm}|${load}`);
              return (
                <div
                  key={`${rpm}-${load}`}
                  className="cell"
                  style={{ background: c ? color(c.mean) : "transparent" }}
                  title={c ? `${rpm} rpm / ${load} load\n${fmt(c.mean)} (n=${c.n})` : `${rpm} rpm / ${load} load\nno data`}
                >
                  {c ? fmt(c.mean) : ""}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// Colour scales. clamp maps a value to 0..1 across [-span,span] or [0,span].
const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
const rgb = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`;

// Diverging: rich (negative) → blue, on-target → grey, lean (positive) → red.
export const divergeColor = (span: number) => (v: number) => {
  const t = Math.max(-1, Math.min(1, v / span));
  if (t < 0) return rgb(lerp(120, 60, -t), lerp(120, 110, -t), lerp(120, 210, -t));
  return rgb(lerp(120, 200, t), lerp(120, 60, t), lerp(120, 60, t));
};
// Knock: 0 → transparent-ish, more negative → deeper red.
export const knockColor = (v: number) => {
  const t = Math.max(0, Math.min(1, -v / 3));
  return rgb(lerp(40, 200, t), lerp(40, 40, t), lerp(40, 40, t));
};
// Sequential blue→amber for timing/boost.
export const seqColor = (min: number, max: number) => (v: number) => {
  const t = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0.5;
  return rgb(lerp(40, 220, t), lerp(80, 170, t), lerp(160, 40, t));
};
