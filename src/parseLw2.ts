import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// Innovate LogWorks LW2.0 boost/AFR binary. Reverse-engineered from the sample batch (SPEC §3.2):
//   - magic "LW2.0\0"
//   - 4 channel defs, one per 236-byte block starting at offset 52 (O2/AFR, RPM, BOOST, OnOFF).
//     Each block's gauge calibration min/max are float32-LE at block+144 / block+148.
//   - sample data is PLANAR: 4 equal slots of N samples, each a 10-bit value (0..1023) as uint16-LE.
//     phys = min + (raw/1023)*(max-min). 1023 = pegged/rail. Data begins at DATA_START.
//   - channels the Innovate unit didn't log read all-zero (here RPM+OnOFF) -> reported dead,
//     mirroring how boost is dead in the ECU CSV. AFR is the channel shared with the CSV.
export type Lw2Key = "afr" | "rpm" | "boost" | "on";

export interface Lw2Log {
  filename: string;
  source_type: "innovate_lw2";
  sample_count: number;
  channels: Partial<Record<Lw2Key, number[]>>;
  calibration: Record<Lw2Key, { min: number; max: number }>;
  present_channels: Lw2Key[];
  dead_channels: Lw2Key[];
}

const DEF_BLOCK0 = 52;
const DEF_STRIDE = 236;
const CAL_MIN_OFF = 144;
const CAL_MAX_OFF = 148;
// ponytail: fixed across all sample files (identical channel-def layout). Guarded below by an
// AFR-plausibility check; if a future file differs, scan for the first plausible slot instead.
const DATA_START = 980;
const RUN_GAP_TOL = 8; // merge nonzero runs split by <= this many zeros (AFR rarely reads raw 0)

function nameToKey(name: string): Lw2Key | null {
  const n = name.toUpperCase();
  if (n.includes("O2")) return "afr";
  if (n.includes("RPM")) return "rpm";
  if (n.includes("BOOST")) return "boost";
  if (n.includes("ONOFF")) return "on";
  return null;
}

function cstr(buf: Buffer, off: number): string {
  let s = "";
  for (let i = off; i < off + 24 && buf[i] !== 0; i++) s += String.fromCharCode(buf[i]);
  return s;
}

const dec = (raw: number, min: number, max: number): number => min + (raw / 1023) * (max - min);

export async function parseLw2(path: string): Promise<Lw2Log> {
  const buf = await readFile(path);
  if (buf.subarray(0, 5).toString("latin1") !== "LW2.0")
    throw new Error(`${basename(path)}: not an LW2.0 file`);

  // Channel defs in file order (== planar slot order).
  const order: Lw2Key[] = [];
  const calibration = {} as Lw2Log["calibration"];
  for (let i = 0; i < 4; i++) {
    const b = DEF_BLOCK0 + i * DEF_STRIDE;
    const key = nameToKey(cstr(buf, b));
    if (!key) throw new Error(`${basename(path)}: unknown channel def #${i} "${cstr(buf, b)}"`);
    order.push(key);
    calibration[key] = { min: buf.readFloatLE(b + CAL_MIN_OFF), max: buf.readFloatLE(b + CAL_MAX_OFF) };
  }

  // Sample data spans DATA_START .. the 'sesf' session-frame marker (end of the data chunk).
  const sesf = buf.indexOf(Buffer.from([0x73, 0x65, 0x73, 0x66]), DATA_START);
  const dataEnd = sesf === -1 ? buf.length : sesf;
  const word = (o: number): number => buf.readUInt16LE(o);

  // Each cont block lays out [AFR][RPM][BOOST][OnOFF] planar; here RPM/OnOFF are unwired, so the
  // block leaves two non-zero runs: AFR then BOOST. Extract runs and pair them per block.
  // ponytail: run-pairing (not the post-'sesf' block directory) — assumes each block emits an
  // AFR run then an equal-length BOOST run. Guarded by the length check below; parse the directory
  // if a block ever logs RPM/OnOFF or an empty channel.
  const runs: number[][] = [];
  let cur: number[] | null = null;
  let gap = 0;
  for (let o = DATA_START; o + 1 < dataEnd; o += 2) {
    const v = word(o);
    if (v !== 0) {
      if (!cur) { cur = []; runs.push(cur); }
      cur.push(v);
      gap = 0;
    } else if (cur) {
      if (++gap > RUN_GAP_TOL) cur = null;
      else cur.push(0); // small internal gap kept; trimmed below
    }
  }
  for (const r of runs) while (r.length && r[r.length - 1] === 0) r.pop();
  if (runs.length === 0) throw new Error(`${basename(path)}: no sample data`);
  if (runs.length % 2 !== 0) throw new Error(`${basename(path)}: ${runs.length} runs, expected AFR/BOOST pairs`);

  // Guard the AFR anchor: first run must decode to a plausible AFR value (SPEC raw 517 -> 14.95).
  const a0 = dec(runs[0][0], calibration.afr.min, calibration.afr.max);
  if (a0 < calibration.afr.min - 0.1 || a0 > calibration.afr.max + 0.1)
    throw new Error(`${basename(path)}: first run not plausible AFR (got ${a0.toFixed(2)})`);

  const afrRaw: number[] = [];
  const boostRaw: number[] = [];
  for (let i = 0; i < runs.length; i += 2) {
    const afrRun = runs[i], boostRun = runs[i + 1];
    if (Math.abs(afrRun.length - boostRun.length) > 2)
      throw new Error(`${basename(path)}: block ${i / 2} AFR/BOOST length mismatch (${afrRun.length} vs ${boostRun.length})`);
    afrRaw.push(...afrRun);
    boostRaw.push(...boostRun);
  }

  const channels: Lw2Log["channels"] = {
    afr: afrRaw.map((r) => dec(r, calibration.afr.min, calibration.afr.max)),
    boost: boostRaw.map((r) => dec(r, calibration.boost.min, calibration.boost.max)),
  };

  return {
    filename: basename(path),
    source_type: "innovate_lw2",
    sample_count: afrRaw.length,
    channels,
    calibration,
    present_channels: ["afr", "boost"],
    dead_channels: ["rpm", "on"],
  };
}
