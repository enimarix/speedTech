// Shared toolkit for the analysis (§6) and diff (§7) engines: RPM×Load binning onto the car's
// grid, segmentation, and small stats. Kept separate because the diff engine reuses the binning.
import type { ParsedLog, ChannelKey } from "./parseCsv.js";

export interface CarConfig {
  rpm_axis: number[];
  load_axis: number[];
  afr_target_wot: number;
  afr_target_cruise: number;
  afr_tolerance: number;
  wot_tps_pct: number;
  knock_warn_deg: number;
  knock_crit_deg: number;
  trim_scale_threshold: number;
  redline: number;
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
export function quantile(xs: number[], q: number): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (i - lo) * (s[Math.min(lo + 1, s.length - 1)] - s[lo]);
}

// EWMA smoothing (α in (0,1]; higher = less smoothing).
function ewma(xs: number[], alpha = 0.3): number[] {
  const out: number[] = [];
  let prev = xs[0];
  for (const x of xs) { prev = alpha * x + (1 - alpha) * prev; out.push(prev); }
  return out;
}

// Nearest breakpoint index — every map and comparison is expressed on the table's own axes (§4).
export function binIndex(v: number, axis: number[]): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(v - axis[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
export const cellKey = (ri: number, li: number): string => `r${ri}_l${li}`;

// Above this AFR the wideband is pegged at its gauge rail because fuelling stopped (fuel cut on
// overrun / gear-shift / coasting), not because the mixture is lean — 20.33 in the samples (§3.3).
export const AFR_PEGGED_LEAN = 17;

export type Segment = "idle" | "cruise" | "pull" | "decel";
export interface Segmentation {
  labels: Segment[];
  rpmPerSec: number[];
  tpsMax: number;
}

// Split into idle | cruise | pull | decel (§6.A). A pull = relative-WOT with rising RPM; a decel =
// closed throttle + falling RPM + AFR pegged lean (fuel-cut, excluded from lean flags downstream).
export function segment(csv: ParsedLog, cfg: CarConfig): Segmentation {
  const ch = (k: ChannelKey) => csv.channels[k] ?? [];
  const time = ch("time_ms"), rpm = ch("rpm"), tps = ch("tps"), afr = ch("afr");
  const n = rpm.length;
  const tpsMax = Math.max(...tps);
  const closed = Math.max(4, 0.12 * tpsMax);
  const wot = tpsMax * (cfg.wot_tps_pct / 100);
  // ponytail: a session only contains pulls if it actually reached real throttle (TPS tops ~74.5%,
  // §3.3), so relative-WOT doesn't turn a gentle coast into "pulls". Tune if a car's TPS scaling differs.
  const hasWot = tpsMax >= 40;

  // rpm/sec from smoothed RPM and the time axis (ms → s).
  const rs = ewma(rpm, 0.3);
  const rpmPerSec: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dt = (time[i] - time[i - 1]) / 1000;
    rpmPerSec[i] = dt > 0 ? (rs[i] - rs[i - 1]) / dt : 0;
  }

  const labels: Segment[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const isClosed = tps[i] <= closed;
    const leanPegged = afr.length ? afr[i] >= AFR_PEGGED_LEAN : false;
    if (isClosed && rpmPerSec[i] < -150 && leanPegged) labels[i] = "decel";
    else if (hasWot && tps[i] >= wot && rpmPerSec[i] > 100) labels[i] = "pull";
    else if (rpm[i] < 1100 && isClosed) labels[i] = "idle";
    else labels[i] = "cruise";
  }
  return { labels, rpmPerSec, tpsMax };
}

// Contiguous runs of a given label (used for per-pull WOT-AFR reporting).
export function runsOf(labels: Segment[], target: Segment): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === target && start === -1) start = i;
    else if (labels[i] !== target && start !== -1) { runs.push([start, i - 1]); start = -1; }
  }
  if (start !== -1) runs.push([start, labels.length - 1]);
  return runs;
}
