// Per-session analysis engine (SPEC §6). Deterministic; hunts for *interesting* information and
// emits typed, ranked findings. This structured object is the single source of truth and the only
// thing the AI layer (§8) ever sees. Every value that isn't from a present channel is skipped.
import type { ParsedLog, ChannelKey } from "./parseCsv.js";
import {
  type CarConfig, type Segment, segment, runsOf, binIndex, cellKey, mean, std, quantile, AFR_PEGGED_LEAN,
} from "./grid.js";

export type Severity = "info" | "warn" | "critical";
export interface Finding {
  severity: Severity;
  code: string;
  cell?: string;
  message: string;
  confidence: number; // 0..1
  evidence: Record<string, unknown>;
}
export interface CellStat {
  cell: string; rpm_bin: number; load_bin: number; n: number; mean: number; min: number; max: number;
}
export interface KnockEvent {
  t_start: number; t_end: number; peak: number; rpm: number; load: number;
  ign: number; afr: number; ect: number; iat: number; cell: string; noise: boolean;
}
export interface SessionAnalysis {
  segments: Record<Segment, number>;
  events: KnockEvent[];
  maps: { afr_error: CellStat[]; ign: CellStat[]; knock: CellStat[]; boost?: CellStat[] };
  trims: { total_mean: number; idle_mean: number; cruise_mean: number; load_mean: number };
  recommendations: Finding[];
  quality: { dead_channels: string[]; sample_rate_hz: number; issues: string[] };
  findings: Finding[];
}

const SEV_WEIGHT: Record<Severity, number> = { info: 1, warn: 2, critical: 4 };

// Accumulate a per-cell map of `values` over the rows selected by `mask`.
function cellMap(
  values: number[], rpm: number[], load: number[], cfg: CarConfig, mask: (i: number) => boolean,
): CellStat[] {
  const acc = new Map<string, { ri: number; li: number; v: number[] }>();
  for (let i = 0; i < values.length; i++) {
    if (!mask(i) || !Number.isFinite(values[i])) continue;
    const ri = binIndex(rpm[i], cfg.rpm_axis), li = binIndex(load[i], cfg.load_axis);
    const key = cellKey(ri, li);
    let e = acc.get(key);
    if (!e) { e = { ri, li, v: [] }; acc.set(key, e); }
    e.v.push(values[i]);
  }
  return [...acc.entries()].map(([cell, e]) => ({
    cell, rpm_bin: cfg.rpm_axis[e.ri], load_bin: cfg.load_axis[e.li],
    n: e.v.length, mean: mean(e.v), min: Math.min(...e.v), max: Math.max(...e.v),
  }));
}

export function analyzeSession(
  csv: ParsedLog, cfg: CarConfig, opts: { boost?: number[]; forcedInduction?: boolean } = {},
): SessionAnalysis {
  const ch = (k: ChannelKey) => csv.channels[k] ?? [];
  const time = ch("time_ms"), rpm = ch("rpm"), load = ch("load"), tps = ch("tps"), afr = ch("afr");
  const knock = ch("knock_corr"), ign = ch("ign_adv"), ect = ch("ect"), iat = ch("iat");
  const ltft = ch("ltft1"), stft = ch("stft1");
  const n = rpm.length;

  const seg = segment(csv, cfg);
  const { labels } = seg;
  const findings: Finding[] = [];
  const recommendations: Finding[] = [];

  const segments: Record<Segment, number> = { idle: 0, cruise: 0, pull: 0, decel: 0 };
  for (const l of labels) segments[l]++;

  // --- B. Knock intelligence ---------------------------------------------------------------------
  const events: KnockEvent[] = [];
  if (knock.length) {
    const warn = cfg.knock_warn_deg;
    let i = 0;
    while (i < n) {
      if (knock[i] <= warn) {
        const start = i;
        let peakI = i, gap = 0, j = i;
        while (j < n && gap < 3) { // hysteresis: end after 3 non-knock rows
          if (knock[j] <= warn) { gap = 0; if (knock[j] < knock[peakI]) peakI = j; }
          else gap++;
          j++;
        }
        const end = j - 1 - gap;
        events.push({
          t_start: time[start], t_end: time[end], peak: knock[peakI],
          rpm: rpm[start], load: load[start], ign: ign[start] ?? NaN, afr: afr[start] ?? NaN,
          ect: ect[start] ?? NaN, iat: iat[start] ?? NaN,
          cell: cellKey(binIndex(rpm[start], cfg.rpm_axis), binIndex(load[start], cfg.load_axis)),
          noise: false,
        });
        i = j;
      } else i++;
    }
    // Cell repeatability: isolated cell = likely noise; repeated cell = real hotspot (§6.B).
    const perCell = new Map<string, KnockEvent[]>();
    for (const e of events) (perCell.get(e.cell) ?? perCell.set(e.cell, []).get(e.cell)!).push(e);
    for (const e of events) e.noise = perCell.get(e.cell)!.length < 2;

    for (const [cell, evs] of perCell) {
      if (evs.length < 2) continue; // real hotspots only
      const peak = Math.min(...evs.map((e) => e.peak));
      const durMs = evs.reduce((a, e) => a + (e.t_end - e.t_start), 0);
      const onTarget = evs.some((e) => Number.isFinite(e.afr) && Math.abs(e.afr - cfg.afr_target_cruise) <= cfg.afr_tolerance);
      const lean = evs.some((e) => Number.isFinite(e.afr) && e.afr > cfg.afr_target_wot + cfg.afr_tolerance && e.load > quantile(load, 0.6));
      const severity: Severity = peak <= cfg.knock_crit_deg ? "critical" : "warn";
      const cause = lean ? "lean-driven — fix fuel first" : onTarget && peak <= -6 ? "timing too aggressive here" : "recurring knock";
      findings.push({
        severity, code: "knock.hotspot", cell,
        message: `Repeated knock at ${evs[0].rpm} rpm / load ${evs[0].load.toFixed(0)} (${evs.length}× events, peak ${peak.toFixed(1)}°) — ${cause}`,
        confidence: Math.min(1, 0.5 + evs.length / 10),
        evidence: { events: evs.length, peak, durMs, rpm: evs[0].rpm, load: evs[0].load },
      });
    }
  }

  // --- C. AFR-error map (core tuning output) -----------------------------------------------------
  // Exclude decel fuel-cut and cold/accel enrichment transients (§3.3, §6.C).
  // AFR_PEGGED_LEAN guards the fuel-cut case at the source: the wideband rails near its gauge max
  // (20.33 in the samples) whenever fuelling stops — on overrun, gear-shift cuts, and coasting. That
  // is not a mixture the tune controls, and segmentation alone misses it (a shift cut keeps the
  // throttle open, so it never looks like decel), so every consumer of the AFR map filters on the
  // value itself rather than on the label. Without this ~4.5k sample rows read as +5.6..+8.5 lean.
  const afrMask = (i: number) => labels[i] !== "decel" && afr[i] >= 10.5 && afr[i] < AFR_PEGGED_LEAN;
  const afrTarget = (i: number) => (labels[i] === "pull" ? cfg.afr_target_wot : cfg.afr_target_cruise);
  const afrErr = afr.map((v, i) => v - afrTarget(i));
  const afrErrorMap = cellMap(afrErr, rpm, load, cfg, afrMask);
  for (const c of afrErrorMap) {
    if (c.n < 5) continue;
    if (c.mean > cfg.afr_tolerance && c.load_bin > quantile(cfg.load_axis, 0.5)) {
      findings.push({
        severity: c.mean > cfg.afr_tolerance * 3 ? "critical" : "warn", code: "afr.lean_under_load", cell: c.cell,
        message: `Lean under load at ${c.rpm_bin} rpm / ${c.load_bin} — +${c.mean.toFixed(2)} AFR lean of target`,
        confidence: Math.min(1, c.n / 20), evidence: { afr_error: c.mean, n: c.n },
      });
    } else if (c.mean < -cfg.afr_tolerance) {
      findings.push({
        severity: "info", code: "afr.over_rich", cell: c.cell,
        message: `Over-rich at ${c.rpm_bin} rpm / ${c.load_bin} — ${c.mean.toFixed(2)} below target`,
        confidence: Math.min(1, c.n / 20), evidence: { afr_error: c.mean, n: c.n },
      });
    }
  }
  // WOT-pull AFR per pull vs target_wot.
  for (const [a, b] of runsOf(labels, "pull")) {
    // Same pegged-lean guard: a mid-pull gear-shift fuel cut must not count as the pull's AFR.
    const seg2 = afr.slice(a, b + 1).filter((v) => v >= 10.5 && v < AFR_PEGGED_LEAN);
    if (seg2.length < 3) continue;
    const mn = Math.min(...seg2), mu = mean(seg2);
    if (mn > cfg.afr_target_wot + cfg.afr_tolerance) {
      findings.push({
        severity: "warn", code: "afr.wot_lean",
        message: `WOT pull lean: min AFR ${mn.toFixed(1)} / mean ${mu.toFixed(1)} vs target ${cfg.afr_target_wot}`,
        confidence: 0.8, evidence: { min: mn, mean: mu, target: cfg.afr_target_wot, rows: seg2.length },
      });
    }
  }

  // --- D. MAF / fuel-trim scaling ----------------------------------------------------------------
  const total = ltft.map((v, i) => v + (stft[i] ?? 0));
  const loadHi = quantile(load, 0.6);
  const trims = {
    total_mean: mean(total),
    idle_mean: mean(total.filter((_, i) => labels[i] === "idle")),
    cruise_mean: mean(total.filter((_, i) => labels[i] === "cruise")),
    load_mean: mean(total.filter((_, i) => load[i] > loadHi)),
  };
  if (ltft.length && Math.abs(trims.total_mean) > cfg.trim_scale_threshold) {
    const factor = 1 + trims.total_mean / 100;
    recommendations.push({
      severity: "warn", code: "maf.rescale",
      message: `Total fuel trim ${trims.total_mean.toFixed(1)}% > ±${cfg.trim_scale_threshold}% — rescale MAF ×${factor.toFixed(3)} (New = Old × (1 + %trim/100))`,
      confidence: 0.7, evidence: { total_mean: trims.total_mean, factor },
    });
  }
  if (Number.isFinite(trims.idle_mean) && trims.idle_mean > cfg.trim_scale_threshold && Math.abs(trims.cruise_mean) < cfg.trim_scale_threshold) {
    findings.push({
      severity: "warn", code: "trim.idle_only",
      message: `Large positive trim at idle only (${trims.idle_mean.toFixed(1)}%) — possible vacuum leak`,
      confidence: 0.6, evidence: { idle_mean: trims.idle_mean, cruise_mean: trims.cruise_mean },
    });
  }

  // --- E. Ignition-timing map --------------------------------------------------------------------
  const ignMap = cellMap(ign, rpm, load, cfg, () => true);

  // --- F. Boost analysis (forced-induction, aligned from Innovate) -------------------------------
  let boostMap: CellStat[] | undefined;
  if (opts.forcedInduction && opts.boost?.length) {
    const boost = opts.boost;
    boostMap = cellMap(boost, rpm, load, cfg, (i) => i < boost.length);
    const peak = Math.max(...boost.filter(Number.isFinite));
    findings.push({
      severity: "info", code: "boost.peak",
      message: `Peak boost ${peak.toFixed(1)} psi`, confidence: 0.9, evidence: { peak },
    });
    // boost-vs-knock correlation: knock events occurring above median boost.
    const medBoost = quantile(boost, 0.5);
    const knockUnderBoost = events.filter((e) => {
      const idx = time.findIndex((t) => t >= e.t_start);
      return idx >= 0 && idx < boost.length && boost[idx] > medBoost;
    });
    if (knockUnderBoost.length) {
      findings.push({
        severity: "warn", code: "boost.knock", message: `${knockUnderBoost.length} knock event(s) under boost`,
        confidence: 0.6, evidence: { count: knockUnderBoost.length, medBoost },
      });
    }
  }

  // --- G. Sensor & data quality ------------------------------------------------------------------
  const issues: string[] = [];
  const dts: number[] = [];
  for (let i = 1; i < time.length; i++) dts.push(time[i] - time[i - 1]);
  const dtMed = quantile(dts, 0.5);
  const gaps = dts.filter((d) => d > dtMed * 3).length;
  if (gaps > 0) issues.push(`${gaps} time gap(s) > 3× median interval`);
  if (ect.length && Math.max(...ect) > 120) issues.push(`ECT peak ${Math.max(...ect).toFixed(0)}°C (overheat range)`);
  if (std(dts) > dtMed * 0.5) issues.push("irregular sample rate");
  const quality = { dead_channels: csv.dead_channels, sample_rate_hz: csv.sample_rate_hz, issues };
  for (const issue of issues) findings.push({ severity: "info", code: "quality", message: issue, confidence: 0.8, evidence: {} });

  // --- H. Findings ranker: safety-criticality × confidence ---------------------------------------
  findings.sort((a, b) => SEV_WEIGHT[b.severity] * b.confidence - SEV_WEIGHT[a.severity] * a.confidence);

  return {
    segments, events,
    maps: { afr_error: afrErrorMap, ign: ignMap, knock: cellMap(knock, rpm, load, cfg, (i) => knock[i] < 0), boost: boostMap },
    trims, recommendations, quality, findings,
  };
}
