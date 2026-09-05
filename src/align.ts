// Time-align an Innovate log to a RomRaider CSV by cross-correlating a shared channel (SPEC §3.2).
// Here the shared channel is AFR (Innovate RPM is unwired/dead). The log and CSV run at different
// rates and lengths, so we resample the log series onto the CSV sample count, then slide to find the
// lag with maximum Pearson correlation. The peak correlation is the alignment confidence.

// Linear resample of a uniformly-sampled series to a new length.
export function resample(src: number[], outLen: number): number[] {
  if (src.length === 0 || outLen <= 0) return [];
  if (src.length === 1) return new Array(outLen).fill(src[0]);
  const out = new Array<number>(outLen);
  for (let i = 0; i < outLen; i++) {
    const t = (i * (src.length - 1)) / (outLen - 1);
    const lo = Math.floor(t);
    const hi = Math.min(lo + 1, src.length - 1);
    out[i] = src[lo] + (t - lo) * (src[hi] - src[lo]);
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

export interface Alignment {
  lag: number;        // shift (in CSV samples) to apply to the log series to match the CSV
  confidence: number; // peak Pearson correlation over the overlap
}

// Best lag of `a` against `b` (same length), searching ±maxLag. Correlation computed on the overlap.
export function bestLag(a: number[], b: number[], maxLagFrac = 0.5): Alignment {
  const maxLag = Math.floor(a.length * maxLagFrac);
  let best: Alignment = { lag: 0, confidence: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const av: number[] = [], bv: number[] = [];
    for (let i = 0; i < b.length; i++) {
      const j = i - lag;
      if (j >= 0 && j < a.length) { av.push(a[j]); bv.push(b[i]); }
    }
    if (av.length < a.length * 0.5) continue; // need enough overlap to trust the score
    const c = pearson(av, bv);
    if (c > best.confidence) best = { lag, confidence: c };
  }
  return best;
}

export interface Window { start: number; length: number; confidence: number }

// Find WHICH slice of the log covers the CSV. The two files are independent recordings: the Innovate
// log runs at its own rate and usually spans a different (longer) period than the ECU CSV, so
// stretching the whole log onto the CSV grid warps the time base — boost then lands in the wrong
// RPM×Load cells (measured r(load,boost) = -0.32, i.e. backwards, vs +0.85 once windowed).
// So search over window length (= relative sample rate) AND start offset, scoring each candidate by
// correlation on the shared channel. This subsumes lag: the offset IS the lag.
// ponytail: brute-force scan, ~1.5k candidates on the sample logs — instant at this size. Parse the
// per-block timestamps from the LW2 directory if logs ever get big enough for this to drag.
export function findWindow(logSeries: number[], csvSeries: number[]): Window {
  const n = logSeries.length;
  let best: Window = { start: 0, length: n, confidence: -Infinity };
  const minLen = Math.max(20, Math.floor(n * 0.05));
  const lenStep = Math.max(1, Math.round(n / 40));
  for (let length = minLen; length <= n; length += lenStep) {
    const startStep = Math.max(1, Math.round(length / 20));
    for (let start = 0; start + length <= n; start += startStep) {
      const c = pearson(resample(logSeries.slice(start, start + length), csvSeries.length), csvSeries);
      if (c > best.confidence) best = { start, length, confidence: c };
    }
  }
  return best;
}

// Align a log channel to a CSV channel of the same physical quantity (e.g. AFR<->AFR) by finding the
// log window that best matches, then resampling that window onto the CSV grid.
export function alignToCsv(logSeries: number[], csvSeries: number[]): Alignment & { resampled: number[]; window: Window } {
  const window = findWindow(logSeries, csvSeries);
  const resampled = resample(logSeries.slice(window.start, window.start + window.length), csvSeries.length);
  return { lag: 0, confidence: window.confidence, resampled, window };
}

// Apply an already-found window to another channel of the same log (e.g. boost, once AFR picked it).
export function applyWindow(series: number[], w: Window, outLen: number): number[] {
  return resample(series.slice(w.start, w.start + w.length), outLen);
}
