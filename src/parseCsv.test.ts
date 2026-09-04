// Runnable check for the CSV parser — asserts against the 9 committed sample logs (SPEC §3.3, §13).
// Run: npx tsx src/parseCsv.test.ts
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRomraiderCsv, type ChannelKey } from "./parseCsv.js";

const LOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");
const ALL_KEYS: ChannelKey[] = [
  "time_ms", "ect", "iat", "ign_adv", "ipw", "load", "maf", "rpm", "tps", "iacv",
  "idle_ft1", "ltft1", "stft1", "v_maf", "v_o2", "knock_corr", "boost_psi", "afr",
];
const max = (xs: number[]) => xs.reduce((a, b) => (Number.isFinite(b) && b > a ? b : a), -Infinity);
const min = (xs: number[]) => xs.reduce((a, b) => (Number.isFinite(b) && b < a ? b : a), Infinity);

const files = (await readdir(LOGS)).filter((f) => f.toLowerCase().endsWith(".csv")).sort();
assert.equal(files.length, 9, `expected 9 sample CSVs, found ${files.length}`);

let anyKnock = false;
let tpsMaxAll = -Infinity;

for (const f of files) {
  const log = await parseRomraiderCsv(join(LOGS, f));

  // 18 columns, identical schema across all files (SPEC §3.1).
  assert.equal(Object.keys(log.channels).length, 18, `${f}: expected 18 mapped channels`);
  for (const k of ALL_KEYS) assert.ok(log.channels[k], `${f}: missing channel ${k}`);

  // Boost lives in the .log.txt, not the CSV — boost_psi must read dead (SPEC §3.1/§3.3).
  assert.ok(log.dead_channels.includes("boost_psi"), `${f}: boost_psi should be dead`);
  assert.ok(!log.present_channels.includes("boost_psi"), `${f}: boost_psi wrongly present`);

  // Sample rate ~12.5 Hz.
  assert.ok(log.sample_rate_hz > 10 && log.sample_rate_hz < 15, `${f}: sample_rate ${log.sample_rate_hz}`);
  assert.ok(log.row_count > 0 && log.duration_s > 0, `${f}: empty log`);

  // TPS tops ~74.5% at WOT, never 100 (SPEC §3.3).
  const tpsMax = max(log.channels.tps!);
  assert.ok(tpsMax < 90, `${f}: tps max ${tpsMax} should be <90 (tops ~74.5%)`);
  tpsMaxAll = Math.max(tpsMaxAll, tpsMax);

  // knock_corr: 0 = none, negative = timing pulled. Track whether any session shows knock.
  if (min(log.channels.knock_corr!) < 0) anyKnock = true;
}

// Across the batch, WOT is reached somewhere and TPS peaks near the documented ~74.5% ceiling.
assert.ok(tpsMaxAll >= 65 && tpsMaxAll < 90, `batch tps max ${tpsMaxAll} not near ~74.5%`);
// The batch contains knock events (SPEC §3.3: knock clusters at part-throttle).
assert.ok(anyKnock, "expected knock (negative knock_corr) somewhere in the batch");

console.log(`ok — parsed ${files.length} logs; batch TPS max ${tpsMaxAll.toFixed(1)}%, knock present: ${anyKnock}`);
