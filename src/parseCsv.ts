import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// Canonical channel keys (SPEC §3.1). channels[key] is a parallel array, one value per row.
export type ChannelKey =
  | "time_ms" | "ect" | "iat" | "ign_adv" | "ipw" | "load" | "maf" | "rpm"
  | "tps" | "iacv" | "idle_ft1" | "ltft1" | "stft1" | "v_maf" | "v_o2"
  | "knock_corr" | "boost_psi" | "afr";

export interface ParsedLog {
  filename: string;
  source_type: "romraider_csv";
  row_count: number;
  duration_s: number;
  sample_rate_hz: number;
  channels: Partial<Record<ChannelKey, number[]>>;
  present_channels: ChannelKey[]; // mapped columns that carry real data
  dead_channels: ChannelKey[];    // mapped columns that are all-zero / all-NaN (e.g. boost in CSV)
}

// Header → key by keyword. Ordered specific→general so v_maf beats maf. Tolerant of RomRaider's
// junk-dot prefixes and column reordering — we never map by position.
const HEADER_RULES: [test: (h: string) => boolean, key: ChannelKey][] = [
  [(h) => h.includes("time"), "time_ms"],
  [(h) => h.includes("ect"), "ect"],
  [(h) => h.includes("iat"), "iat"],
  [(h) => h.includes("ign"), "ign_adv"],
  [(h) => h.includes("ipw"), "ipw"],
  [(h) => h.includes("v_maf"), "v_maf"],
  [(h) => h.includes("maf"), "maf"],
  [(h) => h.includes("load"), "load"],
  [(h) => h.includes("rpm"), "rpm"],
  [(h) => h.includes("tps"), "tps"],
  [(h) => h.includes("iacv"), "iacv"],
  [(h) => h.includes("idleft"), "idle_ft1"],
  [(h) => h.includes("ltft"), "ltft1"],
  [(h) => h.includes("stft"), "stft1"],
  [(h) => h.includes("v_o2") || h.includes("o2"), "v_o2"],
  [(h) => h.includes("knock"), "knock_corr"],
  [(h) => h.includes("psb") || h.includes("ch3") || h.includes("psi"), "boost_psi"],
  [(h) => h.includes("wideband") || h.includes("afr"), "afr"],
];

function headerToKey(raw: string): ChannelKey | null {
  const h = raw.toLowerCase();
  for (const [test, key] of HEADER_RULES) if (test(h)) return key;
  return null;
}

// "20,8" -> 20.8 ; "" / junk -> NaN (skipped downstream, never treated as 0 — SPEC §6).
function num(cell: string): number {
  const v = parseFloat(cell.trim().replace(",", "."));
  return v;
}

function median(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const isDead = (xs: number[]): boolean => xs.every((x) => x === 0 || !Number.isFinite(x));

// Parse a RomRaider CSV (latin-1, ';'-delimited, decimal comma, ~12.5 Hz) into the canonical model.
export async function parseRomraiderCsv(path: string): Promise<ParsedLog> {
  const text = await readFile(path, "latin1");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error(`${basename(path)}: no data rows`);

  const headers = lines[0].split(";");
  const keys = headers.map(headerToKey);
  const channels: Partial<Record<ChannelKey, number[]>> = {};
  for (const k of keys) if (k) channels[k] = [];

  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(";");
    for (let c = 0; c < keys.length; c++) {
      const k = keys[c];
      if (k) channels[k]!.push(num(cells[c] ?? ""));
    }
  }

  const row_count = lines.length - 1;
  const time = channels.time_ms ?? [];
  const duration_s = time.length >= 2 ? (time[time.length - 1] - time[0]) / 1000 : 0;
  const dts: number[] = [];
  for (let i = 1; i < time.length; i++) dts.push(time[i] - time[i - 1]);
  const dt = median(dts);
  const sample_rate_hz = Number.isFinite(dt) && dt > 0 ? 1000 / dt : NaN;

  const mapped = Object.keys(channels) as ChannelKey[];
  const dead_channels = mapped.filter((k) => isDead(channels[k]!));
  const present_channels = mapped.filter((k) => !dead_channels.includes(k));

  return {
    filename: basename(path),
    source_type: "romraider_csv",
    row_count,
    duration_s,
    sample_rate_hz,
    channels,
    present_channels,
    dead_channels,
  };
}
