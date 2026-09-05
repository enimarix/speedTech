import { Router } from "express";
import multer from "multer";
import type { Pool } from "pg";
import { buildSession, type UploadFile } from "./session.js";
import type { CarConfig } from "./grid.js";

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

  return r;
}
