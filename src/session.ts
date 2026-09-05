// Session pipeline (SPEC §5): turn an uploaded batch (RomRaider CSV + optional Innovate .log.txt)
// into one analyzed session. Pure — no DB/HTTP — so it's unit-tested against the sample logs.
import { parseRomraiderText, type ParsedLog } from "./parseCsv.js";
import { parseLw2Buffer, type Lw2Log } from "./parseLw2.js";
import { alignToCsv } from "./align.js";
import { analyzeSession, type SessionAnalysis } from "./analyze.js";
import type { CarConfig } from "./grid.js";

export interface UploadFile { filename: string; buffer: Buffer; }
export interface LogSummary {
  filename: string; source_type: string;
  duration_s: number | null; row_count: number | null; sample_rate_hz: number | null;
  present_channels: string[]; dead_channels: string[];
}
export interface BuiltSession {
  logs: LogSummary[];
  analysis: SessionAnalysis;
  boost_alignment: { confidence: number; lag: number } | null;
}

const isLw2 = (buf: Buffer) => buf.subarray(0, 5).toString("latin1") === "LW2.0";

// Shift a CSV-length series by `lag` samples (from AFR cross-correlation); out-of-range → NaN (skipped).
const applyLag = (x: number[], lag: number): number[] => x.map((_, i) => x[i - lag] ?? NaN);

export function buildSession(files: UploadFile[], cfg: CarConfig, forcedInduction: boolean): BuiltSession {
  const csvs: ParsedLog[] = [];
  const lw2s: Lw2Log[] = [];
  for (const f of files) {
    const name = f.filename.toLowerCase();
    if (name.endsWith(".csv")) csvs.push(parseRomraiderText(f.buffer.toString("latin1"), f.filename));
    else if (name.endsWith(".log.txt") || isLw2(f.buffer)) lw2s.push(parseLw2Buffer(f.buffer, f.filename));
    // unknown types ignored
  }
  if (csvs.length === 0) throw new Error("no RomRaider CSV in upload");
  // ponytail: one session = one CSV + optional boost log (SPEC §5). A multi-CSV batch analyzes the
  // longest CSV and attaches the best-aligning boost log; per-file matching (risk #5) is a follow-up.
  const csv = csvs.reduce((a, b) => (b.row_count > a.row_count ? b : a));

  let boost: number[] | undefined;
  let boost_alignment: BuiltSession["boost_alignment"] = null;
  if (forcedInduction && lw2s.length && csv.channels.afr) {
    let best: { lw: Lw2Log; confidence: number; lag: number } | null = null;
    for (const lw of lw2s) {
      if (!lw.channels.afr) continue;
      const a = alignToCsv(lw.channels.afr, csv.channels.afr);
      if (!best || a.confidence > best.confidence) best = { lw, confidence: a.confidence, lag: a.lag };
    }
    if (best?.lw.channels.boost) {
      const { resampled } = alignToCsv(best.lw.channels.boost, csv.channels.afr);
      boost = applyLag(resampled, best.lag);
      boost_alignment = { confidence: best.confidence, lag: best.lag };
    }
  }

  const analysis = analyzeSession(csv, cfg, { boost, forcedInduction });
  const logs: LogSummary[] = [
    {
      filename: csv.filename, source_type: csv.source_type,
      duration_s: csv.duration_s, row_count: csv.row_count, sample_rate_hz: csv.sample_rate_hz,
      present_channels: csv.present_channels, dead_channels: csv.dead_channels,
    },
    ...lw2s.map((lw): LogSummary => ({
      filename: lw.filename, source_type: lw.source_type,
      duration_s: null, row_count: lw.sample_count, sample_rate_hz: null,
      present_channels: lw.present_channels, dead_channels: lw.dead_channels,
    })),
  ];
  return { logs, analysis, boost_alignment };
}
