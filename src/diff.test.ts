// Runnable check for the session-difference engine (SPEC §7). Run: npx tsx src/diff.test.ts
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRomraiderCsv } from "./parseCsv.js";
import { analyzeSession } from "./analyze.js";
import { profile, rollingBaseline, compareSessions, trendScalar, type SessionProfile, type CellAgg } from "./diff.js";
import type { CarConfig } from "./grid.js";

const LOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");
const cfg: CarConfig = {
  rpm_axis: [800, 1200, 1600, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500],
  load_axis: [40, 80, 120, 160, 200, 240, 280, 320, 360, 400],
  afr_target_wot: 13, afr_target_cruise: 14.7, afr_tolerance: 0.3,
  wot_tps_pct: 90, knock_warn_deg: -0.5, knock_crit_deg: -3, trim_scale_threshold: 5, redline: 6500,
};
const analyze = async (f: string) => analyzeSession(await parseRomraiderCsv(join(LOGS, f)), cfg);

// file 33 has a real knock hotspot; profile captures worst_knock and per-cell knock.
const p33 = profile(await analyze("romraiderlog_33_20260903_224331.csv"));
assert.ok(p33.cells.size > 0, "expected cells");
assert.ok(p33.scalars.worst_knock < 0, "expected worst_knock negative for file 33");
const knockCells = [...p33.cells.values()].filter((c) => c.knock_peak < 0);
assert.ok(knockCells.length > 0, "expected knock cells");

// Identical session vs itself → no regressions/improvements (all within noise).
{
  const r = compareSessions(p33, p33, cfg, "self", 8);
  assert.ok(r.compared_cells > 0, "expected compared cells");
  assert.equal(r.findings.length, 0, `identical compare produced ${r.findings.length} findings`);
  console.log(`ok self-diff: ${r.compared_cells} cells compared, 0 findings`);
}

// New knock regression: baseline = file 33 with knock zeroed; next = real file 33 → "new knock" regressions.
{
  const clean = clone(p33);
  for (const c of clean.cells.values()) { c.knock_peak = 0; c.knock_rows = 0; }
  clean.scalars.worst_knock = 0;
  const r = compareSessions(p33, clean, cfg, "clean-baseline", 8);
  const newKnock = r.findings.filter((f) => f.type === "regression" && f.metric === "knock");
  assert.ok(newKnock.length > 0, "expected new-knock regressions");
  assert.equal(r.findings[0].type, "regression", "regressions must rank first");
  console.log(`ok regression: ${newKnock.length} new-knock cell(s), headline "${r.findings[0].message.slice(0, 50)}..."`);

  // Symmetric: knock present in baseline, cleared in next → improvement.
  const imp = compareSessions(clean, p33, cfg, "cleared", 8).findings.filter((f) => f.type === "improvement" && f.metric === "knock");
  assert.ok(imp.length > 0, "expected knock-cleared improvements");
  console.log(`ok improvement: ${imp.length} cleared-knock cell(s)`);
}

// Rolling baseline: median of a small window; trend slope sign.
{
  const base = rollingBaseline([p33, p33, p33], 5);
  assert.ok(base.cells.size > 0, "rolling baseline empty");
  const worsening = [mkProfile(-0.5), mkProfile(-1.0), mkProfile(-2.0)]; // oldest→newest, knock getting worse
  const { slope } = trendScalar(worsening, "worst_knock");
  assert.ok(slope < 0, `expected worsening (negative) slope, got ${slope}`);
  console.log(`ok trend: worst_knock slope ${slope.toFixed(2)}/session (worsening)`);
}

function clone(p: SessionProfile): SessionProfile {
  const cells = new Map<string, CellAgg>();
  for (const [k, c] of p.cells) cells.set(k, { ...c });
  return { cells, scalars: { ...p.scalars } };
}
function mkProfile(worstKnock: number): SessionProfile {
  return { cells: new Map(), scalars: { max_rpm: 6000, peak_boost: null, worst_knock: worstKnock, trim_total: 0, pull_count: 1 } };
}
