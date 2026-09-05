// Runnable check for the LW2.0 boost decoder + CSV alignment (SPEC §3.2, M2).
// Run: npx tsx src/parseLw2.test.ts
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLw2 } from "./parseLw2.js";
import { parseRomraiderCsv } from "./parseCsv.js";
import { alignToCsv, bestLag, resample } from "./align.js";

const LOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");

// --- alignment sanity on synthetic data (known lag must be recovered) ---
{
  const base = Array.from({ length: 400 }, (_, i) => Math.sin(i / 15) + 0.3 * Math.sin(i / 4));
  const shifted = new Array(12).fill(base[0]).concat(base.slice(0, 388)); // lag +12
  const { lag, confidence } = bestLag(base, shifted);
  assert.equal(lag, 12, `synthetic lag: expected 12, got ${lag}`);
  assert.ok(confidence > 0.95, `synthetic corr ${confidence.toFixed(3)} too low`);
  assert.equal(resample([0, 10], 3).join(","), "0,5,10"); // linear resample midpoint
}

const logFiles = (await readdir(LOGS)).filter((f) => f.toLowerCase().endsWith(".log.txt")).sort();
assert.equal(logFiles.length, 3, `expected 3 LW2.0 logs, found ${logFiles.length}`);

const csvFiles = (await readdir(LOGS)).filter((f) => f.toLowerCase().endsWith(".csv")).sort();
const csvs = await Promise.all(
  csvFiles.map(async (f) => ({ f, afr: (await parseRomraiderCsv(join(LOGS, f))).channels.afr! })),
);

for (const f of logFiles) {
  const log = await parseLw2(join(LOGS, f));

  // Decode structure: AFR + BOOST populated, RPM + OnOFF unwired (dead).
  assert.ok(log.present_channels.includes("afr"), `${f}: AFR should be present`);
  assert.ok(log.present_channels.includes("boost"), `${f}: BOOST should be present`);
  assert.ok(log.dead_channels.includes("rpm"), `${f}: RPM should be dead (unwired)`);
  assert.ok(log.dead_channels.includes("on"), `${f}: OnOFF should be dead`);

  // Calibration matches the reverse-engineered gauge ranges (SPEC §3.2). Stored as float32.
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.01, `${a} != ${b}`);
  near(log.calibration.afr.min, 7.35);
  near(log.calibration.afr.max, 22.39);
  near(log.calibration.boost.min, -14.5);
  near(log.calibration.boost.max, 43.5);

  // AFR decode validated against SPEC's known raw->physical points (raw 517 -> 14.95).
  const afr = log.channels.afr!;
  assert.ok(Math.abs(afr[0] - 14.95) < 0.05, `${f}: AFR[0] ${afr[0].toFixed(2)} != ~14.95`);
  assert.ok(afr.every((v) => v >= 7.35 - 1e-6 && v <= 22.39 + 1e-6), `${f}: AFR out of gauge range`);

  // Boost physically sane within its gauge range.
  const boost = log.channels.boost!;
  const bMax = Math.max(...boost), bMin = Math.min(...boost);
  assert.ok(bMin >= -14.5 - 1e-6 && bMax <= 43.5 + 1e-6, `${f}: boost out of range`);

  // VALIDATION: decoded AFR is the same sensor as the CSV's AFR column, so it must correlate with
  // the matching session's CSV AFR. Pick the best-correlating CSV.
  let best = { f: "", confidence: -Infinity, lag: 0 };
  for (const c of csvs) {
    const { confidence, lag } = alignToCsv(afr, c.afr);
    if (confidence > best.confidence) best = { f: c.f, confidence, lag };
  }
  // Single-block logs are one coherent time segment -> alignment must be strong. Multi-block logs
  // concatenate temporally-separated pulls (per-block timestamps live in the post-'sesf' directory,
  // not yet parsed), so whole-series alignment is only approximate — assert it's still positive.
  const singleBlock = log.sample_count < 1000; // PSI 1 is one ~828-sample block
  assert.ok(best.confidence > (singleBlock ? 0.7 : 0.4), `${f}: weak CSV AFR match (${best.confidence.toFixed(2)} vs ${best.f})`);
  console.log(
    `ok ${f}: N=${log.sample_count} boost ${bMin.toFixed(1)}..${bMax.toFixed(1)}psi ` +
    `| AFR~${best.f} r=${best.confidence.toFixed(2)}${singleBlock ? "" : " (multi-block, approx)"}`,
  );
}
