// Runnable check for the per-session analysis engine (SPEC §6). Grounded in the sample batch (§3.3):
// file "33" has the low-rpm part-throttle knock hotspot; pull files reach WOT; drive files decel.
// Run: npx tsx src/analyze.test.ts
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRomraiderCsv } from "./parseCsv.js";
import { parseLw2 } from "./parseLw2.js";
import { resample } from "./align.js";
import { analyzeSession } from "./analyze.js";
import type { CarConfig } from "./grid.js";

const LOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");
const config = (fi: boolean): CarConfig => ({
  rpm_axis: [800, 1200, 1600, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500],
  load_axis: [40, 80, 120, 160, 200, 240, 280, 320, 360, 400],
  afr_target_wot: fi ? 11.8 : 13.0, afr_target_cruise: 14.7, afr_tolerance: 0.3,
  wot_tps_pct: 90, knock_warn_deg: -0.5, knock_crit_deg: -3.0, trim_scale_threshold: 5, redline: 6500,
});
const load = (f: string) => parseRomraiderCsv(join(LOGS, f));

// --- file 33: part-throttle low-rpm knock hotspot (§3.3) ---
{
  const csv = await load("romraiderlog_33_20260903_224331.csv");
  const a = analyzeSession(csv, config(false));
  assert.ok(a.events.length > 0, "expected knock events in file 33");
  const hotspots = a.findings.filter((f) => f.code === "knock.hotspot");
  assert.ok(hotspots.length > 0, "expected a real knock hotspot (repeated cell)");
  const lowRpm = hotspots.find((f) => (f.evidence.rpm as number) < 2000);
  assert.ok(lowRpm, `expected a low-rpm (<2000) hotspot, got ${hotspots.map((h) => h.evidence.rpm).join(",")}`);
  assert.ok(a.events.some((e) => !e.noise), "expected at least one non-noise (repeated) event");
  assert.ok(a.quality.dead_channels.includes("boost_psi"), "boost_psi should be dead in CSV");
  // Every finding is grounded: code + evidence + message.
  for (const f of a.findings) assert.ok(f.code && f.message && f.evidence, "ungrounded finding");
  console.log(`ok file33: ${a.events.length} events, ${hotspots.length} hotspot(s), headline: "${a.findings[0]?.message.slice(0, 60)}..."`);
}

// --- pull file: WOT detected, decel excluded from lean flags ---
{
  const csv = await load("romraiderlog_2GEARPULL3_20260903_231323.csv");
  const a = analyzeSession(csv, config(false));
  assert.ok(a.segments.pull > 0, "expected pull segment in a WOT pull");
  // The AFR 20.3 decel spikes must NOT produce lean-under-load findings (fuel-cut excluded, §6.C).
  const leanFromDecel = a.findings.filter((f) => f.code === "afr.lean_under_load" && (f.evidence.afr_error as number) > 5);
  assert.equal(leanFromDecel.length, 0, "decel fuel-cut wrongly flagged as lean");
  console.log(`ok pull: segments ${JSON.stringify(a.segments)}, findings ${a.findings.length}`);
}

// --- fuel-cut rows must never reach the AFR map (SPEC risk #4) ---
// The wideband rails at ~20.3 whenever fuelling stops (overrun, gear-shift cut, coasting). Those
// rows are not a mixture the tune controls; if they leak in they read as +5.6..+8.5 lean.
{
  for (const f of ["romraiderlog_DRIVE2_20260903_230436.csv", "romraiderlog_33_20260903_224331.csv",
                   "romraiderlog_2GEARPULL3_20260903_231323.csv"]) {
    const a = analyzeSession(await load(f), config(true)); // turbo target 11.8 = worst case
    const worst = Math.max(0, ...a.maps.afr_error.map((c) => c.max));
    assert.ok(worst < 4, `${f}: AFR-error max +${worst.toFixed(1)} implies pegged fuel-cut rows leaked in`);
  }
  // A pull whose rows are all fuel-cut must not report a WOT-lean verdict from railed values.
  const a = analyzeSession(await load("romraiderlog_2GEARPULL3_20260903_231323.csv"), config(true));
  const bogus = a.findings.filter((f) => f.code === "afr.wot_lean" && (f.evidence.min as number) >= 17);
  assert.equal(bogus.length, 0, "fuel-cut AFR used as a pull's min AFR");
  console.log("ok fuel-cut: pegged-lean rows excluded from AFR map and pull verdicts");
}

// --- drive file: decel/coast segment present ---
{
  const csv = await load("romraiderlog_DRIVE_20260903_230053.csv");
  const a = analyzeSession(csv, config(false));
  assert.ok(a.segments.decel > 0 || a.segments.cruise > 0, "expected decel/cruise in a drive");
  console.log(`ok drive: segments ${JSON.stringify(a.segments)}`);
}

// --- boost module (forced-induction, aligned boost from Innovate log) ---
{
  const csv = await load("romraiderlog_3GEARPULL_20260903_231139.csv");
  const lw = await parseLw2(join(LOGS, "PSI 1.log.txt"));
  const boost = resample(lw.channels.boost!, csv.channels.rpm!.length); // approx alignment onto CSV grid
  const a = analyzeSession(csv, config(true), { forcedInduction: true, boost });
  assert.ok(a.maps.boost && a.maps.boost.length > 0, "expected a boost map");
  assert.ok(a.findings.some((f) => f.code === "boost.peak"), "expected a peak-boost finding");
  console.log(`ok boost: peak finding present, boost cells ${a.maps.boost!.length}`);
}

// --- ranker: findings sorted by severity-weight × confidence ---
{
  const csv = await load("romraiderlog_DriveAfterMissGear_20260903_231655.csv");
  const a = analyzeSession(csv, config(false));
  const wt = { info: 1, warn: 2, critical: 4 } as const;
  for (let i = 1; i < a.findings.length; i++) {
    const prev = wt[a.findings[i - 1].severity] * a.findings[i - 1].confidence;
    const cur = wt[a.findings[i].severity] * a.findings[i].confidence;
    assert.ok(prev >= cur - 1e-9, "findings not ranked by severity×confidence");
  }
  console.log(`ok ranker: ${a.findings.length} findings ordered`);
}
