// Runnable check for the session pipeline (SPEC §5). Feeds real sample files as upload buffers.
// Run: npx tsx src/session.test.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSession, type UploadFile } from "./session.js";
import type { CarConfig } from "./grid.js";

const LOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");
const upload = async (f: string): Promise<UploadFile> => ({ filename: f, buffer: await readFile(join(LOGS, f)) });
const cfg = (fi: boolean): CarConfig => ({
  rpm_axis: [800, 1200, 1600, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500],
  load_axis: [40, 80, 120, 160, 200, 240, 280, 320, 360, 400],
  afr_target_wot: fi ? 11.8 : 13.0, afr_target_cruise: 14.7, afr_tolerance: 0.3,
  wot_tps_pct: 90, knock_warn_deg: -0.5, knock_crit_deg: -3.0, trim_scale_threshold: 5, redline: 6500,
});

// CSV-only batch (NA car): analysis produced, one log summary, boost stays dead, no boost alignment.
{
  const s = buildSession([await upload("romraiderlog_33_20260903_224331.csv")], cfg(false), false);
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].source_type, "romraider_csv");
  assert.ok(s.logs[0].dead_channels.includes("boost_psi"));
  assert.ok(s.analysis.findings.length > 0, "expected findings");
  assert.equal(s.boost_alignment, null);
  console.log(`ok csv-only: ${s.analysis.findings.length} findings, headline "${s.analysis.findings[0].message.slice(0, 50)}..."`);
}

// CSV + Innovate log (FI car): boost decoded, aligned, boost map + peak finding produced.
{
  const s = buildSession(
    [await upload("romraiderlog_3GEARPULL_20260903_231139.csv"), await upload("PSI 1.log.txt")],
    cfg(true), true,
  );
  assert.equal(s.logs.length, 2, "expected CSV + log summaries");
  assert.ok(s.logs.some((l) => l.source_type === "innovate_lw2"));
  assert.ok(s.boost_alignment && s.boost_alignment.confidence > 0.5, `boost alignment weak: ${s.boost_alignment?.confidence}`);
  assert.ok(s.analysis.maps.boost && s.analysis.maps.boost.length > 0, "expected boost map");
  assert.ok(s.analysis.findings.some((f) => f.code === "boost.peak"), "expected peak-boost finding");
  console.log(`ok csv+log: boost r=${s.boost_alignment!.confidence.toFixed(2)}, boost cells ${s.analysis.maps.boost!.length}`);
}

// PHYSICS: boost must rise with load. This is the independent check that the log/CSV time windows
// are actually aligned — stretching the whole log onto the CSV grid scores r ≈ -0.32 (backwards),
// a correctly-windowed alignment scores r > 0.5. Guards every CSV+log pair in the sample batch.
{
  const pearson = (a: number[], b: number[]) => {
    const n = a.length, ma = a.reduce((s, c) => s + c, 0) / n, mb = b.reduce((s, c) => s + c, 0) / n;
    let nu = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; nu += x * y; da += x * x; db += y * y; }
    return Math.sqrt(da * db) ? nu / Math.sqrt(da * db) : 0;
  };
  for (const [csvF, logF] of [
    ["romraiderlog_3GEARPULL_20260903_231139.csv", "PSI 1.log.txt"],
    ["romraiderlog_2GEARPULL3_20260903_231323.csv", "4 pull.log.txt"],
    ["romraiderlog_3GEARPULL2_20260903_231159.csv", "second then third.log.txt"],
  ]) {
    const s = buildSession([await upload(csvF), await upload(logF)], cfg(true), true);
    const b = s.analysis.maps.boost!;
    const r = pearson(b.map((c) => c.load_bin), b.map((c) => c.mean));
    assert.ok(r > 0.5, `${csvF} + ${logF}: r(load,boost)=${r.toFixed(2)} — boost not tracking load, alignment is off`);
    const lo = b.filter((c) => c.load_bin <= 80), hi = b.filter((c) => c.load_bin >= 320);
    if (lo.length && hi.length) {
      const m = (x: typeof b) => x.reduce((a, c) => a + c.mean, 0) / x.length;
      assert.ok(m(lo) < m(hi), `${csvF}: low-load boost ${m(lo).toFixed(1)} should be below high-load ${m(hi).toFixed(1)}`);
    }
    console.log(`ok boost-physics ${logF}: r(load,boost)=${r.toFixed(2)}, align r=${s.boost_alignment!.confidence.toFixed(2)}`);
  }
}

// No CSV → rejected.
{
  assert.throws(() => buildSession([{ filename: "x.txt", buffer: Buffer.from("junk") }], cfg(false), false), /no RomRaider CSV/);
  console.log("ok reject: batch without a CSV rejected");
}
