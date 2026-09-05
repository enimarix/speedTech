import { Router } from "express";
import multer from "multer";
import type { Pool } from "pg";
import { buildSession, type UploadFile } from "./session.js";
import type { CarConfig } from "./grid.js";
import { profile, rollingBaseline, compareSessions, trendScalar, type ScalarMetric } from "./diff.js";
import type { SessionAnalysis } from "./analyze.js";

const SCALAR_METRICS: ScalarMetric[] = ["worst_knock", "peak_boost", "trim_total", "max_rpm", "pull_count"];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

export function sessionsRouter(pool: Pool): Router {
  const r = Router();

  // Upload a batch (CSV + optional .log.txt) → parse, align, analyze, persist (SPEC §9).
  r.post("/cars/:id/sessions", upload.array("files"), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) return res.status(400).json({ error: "no files uploaded (field 'files')" });

    const car = (await pool.query("SELECT config_json, forced_induction_json FROM cars WHERE id = $1", [req.params.id])).rows[0];
    if (!car) return res.status(404).json({ error: "car not found" });

    const uploads: UploadFile[] = files.map((f) => ({ filename: f.originalname, buffer: f.buffer }));
    let built;
    try {
      built = buildSession(uploads, car.config_json as CarConfig, Boolean(car.forced_induction_json?.enabled));
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    const label = typeof req.body?.label === "string" ? req.body.label : null;
    const headline = built.analysis.findings[0]?.message ?? null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const s = (await client.query(
        `INSERT INTO sessions (car_id, label, derived, headline) VALUES ($1,$2,$3,$4) RETURNING id, uploaded_at`,
        [req.params.id, label, JSON.stringify(built.analysis), headline],
      )).rows[0];
      for (const l of built.logs) {
        await client.query(
          `INSERT INTO logs (session_id, filename, source_type, duration_s, row_count, sample_rate_hz, present_channels, dead_channels)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [s.id, l.filename, l.source_type, l.duration_s, l.row_count, l.sample_rate_hz, l.present_channels, l.dead_channels],
        );
      }
      await client.query("COMMIT");
      res.status(201).json({
        id: s.id, uploaded_at: s.uploaded_at, headline,
        segments: built.analysis.segments, findings: built.analysis.findings,
        recommendations: built.analysis.recommendations, boost_alignment: built.boost_alignment, logs: built.logs,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  r.get("/cars/:id/sessions", async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, uploaded_at, label, headline FROM sessions WHERE car_id = $1 ORDER BY uploaded_at DESC",
      [req.params.id],
    );
    res.json(rows);
  });

  r.get("/sessions/:id", async (req, res) => {
    const s = (await pool.query("SELECT * FROM sessions WHERE id = $1", [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ error: "session not found" });
    const logs = (await pool.query("SELECT * FROM logs WHERE session_id = $1", [req.params.id])).rows;
    res.json({ ...s, logs });
  });

  // Compare a session against its history (SPEC §7). ?baseline=prev|rolling|<sessionId>, ?n, ?min_samples.
  r.get("/sessions/:id/compare", async (req, res) => {
    const s = (await pool.query("SELECT car_id, derived, uploaded_at FROM sessions WHERE id = $1", [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ error: "session not found" });
    const car = (await pool.query("SELECT config_json FROM cars WHERE id = $1", [s.car_id])).rows[0];
    const cfg = car.config_json as CarConfig;
    const hist = (await pool.query(
      "SELECT id, derived FROM sessions WHERE car_id = $1 AND uploaded_at < $2 ORDER BY uploaded_at DESC",
      [s.car_id, s.uploaded_at],
    )).rows as { id: string; derived: SessionAnalysis }[];
    if (hist.length === 0) return res.json({ baseline: null, message: "no prior sessions to compare against", findings: [] });

    const mode = String(req.query.baseline ?? "prev");
    const minSamples = Number(req.query.min_samples ?? 8);
    const next = profile(s.derived);
    let baseP, label: string;
    if (mode === "rolling") {
      const n = Number(req.query.n ?? 5);
      baseP = rollingBaseline(hist.map((h) => profile(h.derived)), n);
      label = `rolling median of last ${Math.min(n, hist.length)}`;
    } else if (mode === "prev") {
      baseP = profile(hist[0].derived); label = `previous session ${hist[0].id}`;
    } else {
      const b = hist.find((h) => h.id === mode);
      if (!b) return res.status(400).json({ error: `baseline session ${mode} not in this car's history` });
      baseP = profile(b.derived); label = `session ${mode}`;
    }
    res.json(compareSessions(next, baseP, cfg, label, minSamples));
  });

  // Trend a scalar metric over a car's recent sessions (SPEC §7.6/§9). ?metric=worst_knock&n=5.
  r.get("/cars/:id/trends", async (req, res) => {
    const metric = String(req.query.metric ?? "worst_knock") as ScalarMetric;
    if (!SCALAR_METRICS.includes(metric)) return res.status(400).json({ error: `metric must be one of ${SCALAR_METRICS.join(", ")}` });
    const n = Number(req.query.n ?? 5);
    const rows = (await pool.query(
      "SELECT id, uploaded_at, derived FROM sessions WHERE car_id = $1 ORDER BY uploaded_at DESC LIMIT $2",
      [req.params.id, n],
    )).rows as { id: string; uploaded_at: string; derived: SessionAnalysis }[];
    const oldestFirst = [...rows].reverse();
    const { slope, values } = trendScalar(oldestFirst.map((r) => profile(r.derived)), metric);
    res.json({ metric, slope, sessions: oldestFirst.map((r, i) => ({ id: r.id, uploaded_at: r.uploaded_at, value: values[i] })) });
  });

  return r;
}
