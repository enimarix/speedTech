// Session-difference engine (SPEC §7). Compares a session against its history by operating-condition
// cell (never by time), classifies regressions/improvements, and fits trends over recent sessions.
// Everything here is deterministic; it works off the stored §6 analysis (`derived`).
import type { SessionAnalysis, CellStat, Severity } from "./analyze.js";
import type { CarConfig } from "./grid.js";

export interface CellAgg {
  rpm_bin: number; load_bin: number;
  n: number;                 // rows in cell (from the ignition map — spans all rows)
  afr_err: number | null;    // measured − target (decel/enrichment excluded, §6.C)
  ign: number | null;
  knock_peak: number;        // most negative °, 0 = none
  knock_rows: number;
  boost: number | null;
}
export interface SessionScalars {
  max_rpm: number; peak_boost: number | null; worst_knock: number; trim_total: number; pull_count: number;
}
export interface SessionProfile { cells: Map<string, CellAgg>; scalars: SessionScalars; }

const key = (c: { rpm_bin: number; load_bin: number }) => `${c.rpm_bin}|${c.load_bin}`;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Step 1 — Normalize a session to per-cell aggregates + session scalars.
export function profile(a: SessionAnalysis): SessionProfile {
  const cells = new Map<string, CellAgg>();
  const ensure = (c: CellStat) => {
    const k = key(c);
    let e = cells.get(k);
    if (!e) { e = { rpm_bin: c.rpm_bin, load_bin: c.load_bin, n: 0, afr_err: null, ign: null, knock_peak: 0, knock_rows: 0, boost: null }; cells.set(k, e); }
    return e;
  };
  for (const c of a.maps.ign) { const e = ensure(c); e.ign = c.mean; e.n = c.n; }
  for (const c of a.maps.afr_error) ensure(c).afr_err = c.mean;
  for (const c of a.maps.knock) { const e = ensure(c); e.knock_peak = c.min; e.knock_rows = c.n; }
  for (const c of a.maps.boost ?? []) ensure(c).boost = c.mean;

  const rpmBins = [...cells.values()].map((c) => c.rpm_bin);
  const boostMeans = (a.maps.boost ?? []).map((c) => c.mean);
  const knockMins = a.maps.knock.map((c) => c.min);
  const scalars: SessionScalars = {
    max_rpm: rpmBins.length ? Math.max(...rpmBins) : 0,
    peak_boost: boostMeans.length ? Math.max(...boostMeans) : null,
    worst_knock: knockMins.length ? Math.min(...knockMins) : 0,
    trim_total: a.trims.total_mean,
    pull_count: a.segments.pull,
  };
  return { cells, scalars };
}

// Step 2 — Baseline: rolling per-cell median of the last N history profiles (newest-first).
export function rollingBaseline(history: SessionProfile[], n = 5): SessionProfile {
  const window = history.slice(0, n);
  const cells = new Map<string, CellAgg>();
  const allKeys = new Set(window.flatMap((p) => [...p.cells.keys()]));
  for (const k of allKeys) {
    const aggs = window.map((p) => p.cells.get(k)).filter((c): c is CellAgg => !!c);
    if (aggs.length < Math.ceil(window.length / 2)) continue; // seen in <half the window → skip
    const med = (pick: (c: CellAgg) => number | null) => {
      const vs = aggs.map(pick).filter((v): v is number => v !== null);
      return vs.length ? median(vs) : null;
    };
    cells.set(k, {
      rpm_bin: aggs[0].rpm_bin, load_bin: aggs[0].load_bin,
      n: Math.round(median(aggs.map((c) => c.n))),
      afr_err: med((c) => c.afr_err), ign: med((c) => c.ign),
      knock_peak: median(aggs.map((c) => c.knock_peak)),
      knock_rows: Math.round(median(aggs.map((c) => c.knock_rows))),
      boost: med((c) => c.boost),
    });
  }
  const s = (pick: (p: SessionProfile) => number | null) => {
    const vs = window.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
    return vs.length ? median(vs) : null;
  };
  return {
    cells,
    scalars: {
      max_rpm: s((p) => p.scalars.max_rpm) ?? 0,
      peak_boost: s((p) => p.scalars.peak_boost),
      worst_knock: s((p) => p.scalars.worst_knock) ?? 0,
      trim_total: s((p) => p.scalars.trim_total) ?? 0,
      pull_count: s((p) => p.scalars.pull_count) ?? 0,
    },
  };
}

export type DiffType = "regression" | "improvement" | "neutral";
export interface DiffFinding {
  type: DiffType; severity: Severity; cell?: string; metric: string;
  delta: number; significance: number; message: string;
}
export interface DiffResult {
  baseline: string;
  scalar_deltas: Record<string, number | null>;
  findings: DiffFinding[];
  insufficient: number; // cells with too-few samples on one side
  compared_cells: number;
}

// Significance = |Δ| / metric threshold; ≥1 (with the sample gate) is a real change (§7.4).
const THRESH = { afr: (c: CarConfig) => c.afr_tolerance, knock: () => 0.5, boost: () => 1.0, ign: () => 2.0 };

// Steps 3–5 — like-for-like guard, per-cell delta + significance, classify.
export function compareSessions(
  next: SessionProfile, base: SessionProfile, cfg: CarConfig, baselineLabel: string, minSamples = 8,
): DiffResult {
  const findings: DiffFinding[] = [];
  let insufficient = 0, compared = 0;
  const loadHi = cfg.load_axis[Math.floor(cfg.load_axis.length / 2)];

  for (const [k, nc] of next.cells) {
    const bc = base.cells.get(k);
    if (!bc) continue;
    if (nc.n < minSamples || bc.n < minSamples) { insufficient++; continue; }
    compared++;

    // Knock — the headline safety metric.
    if (bc.knock_peak === 0 && nc.knock_peak <= -0.5) {
      findings.push(mk("regression", "critical", k, "knock", nc.knock_peak, Math.abs(nc.knock_peak) / 0.5,
        `New knock at ${nc.rpm_bin} rpm / ${nc.load_bin} (peak ${nc.knock_peak.toFixed(1)}°) — absent in baseline`));
    } else if (bc.knock_peak <= -0.5 && nc.knock_peak === 0) {
      findings.push(mk("improvement", "info", k, "knock", -bc.knock_peak, Math.abs(bc.knock_peak) / 0.5,
        `Knock cleared at ${nc.rpm_bin} rpm / ${nc.load_bin} (was ${bc.knock_peak.toFixed(1)}°)`));
    }

    // AFR — lean-under-load regression / move toward target.
    if (nc.afr_err !== null && bc.afr_err !== null) {
      const d = nc.afr_err - bc.afr_err;
      const sig = Math.abs(d) / THRESH.afr(cfg);
      if (sig >= 1 && d > 0 && nc.load_bin >= loadHi) {
        findings.push(mk("regression", "warn", k, "afr", d, sig,
          `Leaned ${d.toFixed(2)} AFR at ${nc.rpm_bin} rpm / ${nc.load_bin} under load`));
      } else if (sig >= 1 && Math.abs(nc.afr_err) < Math.abs(bc.afr_err)) {
        findings.push(mk("improvement", "info", k, "afr", d, sig,
          `AFR moved toward target at ${nc.rpm_bin} rpm / ${nc.load_bin} (${d.toFixed(2)})`));
      }
    }

    // Boost — per-cell drop.
    if (nc.boost !== null && bc.boost !== null) {
      const d = nc.boost - bc.boost, sig = Math.abs(d) / THRESH.boost();
      if (sig >= 1 && d < 0) findings.push(mk("regression", "warn", k, "boost", d, sig,
        `Boost down ${(-d).toFixed(1)} psi at ${nc.rpm_bin} rpm / ${nc.load_bin}`));
    }
  }

  // Session scalars.
  const scalar_deltas: DiffResult["scalar_deltas"] = {
    peak_boost: delta(next.scalars.peak_boost, base.scalars.peak_boost),
    worst_knock: next.scalars.worst_knock - base.scalars.worst_knock,
    trim_total: next.scalars.trim_total - base.scalars.trim_total,
    max_rpm: next.scalars.max_rpm - base.scalars.max_rpm,
  };
  if (scalar_deltas.peak_boost !== null && scalar_deltas.peak_boost < -1)
    findings.push(mk("regression", "warn", undefined, "peak_boost", scalar_deltas.peak_boost, Math.abs(scalar_deltas.peak_boost),
      `Peak boost down ${(-scalar_deltas.peak_boost).toFixed(1)} psi vs baseline`));

  // Step 7 — rank: regressions first, then by significance.
  const order = { regression: 0, improvement: 1, neutral: 2 };
  findings.sort((a, b) => order[a.type] - order[b.type] || b.significance - a.significance);
  return { baseline: baselineLabel, scalar_deltas, findings, insufficient, compared_cells: compared };
}

const mk = (type: DiffType, severity: Severity, cell: string | undefined, metric: string, delta: number, significance: number, message: string): DiffFinding =>
  ({ type, severity, cell, metric, delta, significance, message });
const delta = (a: number | null, b: number | null): number | null => (a !== null && b !== null ? a - b : null);

// Step 6 — Trend: least-squares slope of a scalar metric over sessions (oldest→newest).
export type ScalarMetric = keyof SessionScalars;
export function trendScalar(oldestFirst: SessionProfile[], metric: ScalarMetric): { slope: number; values: (number | null)[] } {
  const values = oldestFirst.map((p) => p.scalars[metric]);
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (pts.length < 2) return { slope: 0, values };
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0), sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0), sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const denom = n * sxx - sx * sx;
  return { slope: denom === 0 ? 0 : (n * sxy - sx * sy) / denom, values };
}
