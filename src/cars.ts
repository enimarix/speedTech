import { Router } from "express";
import type { Pool } from "pg";

type InductionType = "turbo" | "supercharger" | "none";
interface ForcedInduction { enabled: boolean; type: InductionType; }

interface EngineProfile {
  id: string;
  label: string;
  ecu_default: string;
  redline_default: number;
  axes_json: { rpm_axis_default: number[]; load_axis_default: number[] };
}

// Config defaults (SPEC §4). Seeded from the profile + induction; every value is overridable.
function seedConfig(profile: EngineProfile, fi: ForcedInduction) {
  return {
    afr_target_wot: fi.enabled ? 11.8 : 13.0, // turbo 11.8 (λ0.80) | NA 13.0 (λ0.88)
    afr_target_cruise: 14.7,
    afr_tolerance: 0.3,
    wot_tps_pct: 90,
    knock_warn_deg: -0.5,
    knock_crit_deg: -3.0,
    trim_scale_threshold: 5,
    rpm_axis: profile.axes_json.rpm_axis_default,
    load_axis: profile.axes_json.load_axis_default,
    redline: profile.redline_default,
  };
}

const INDUCTION_TYPES: InductionType[] = ["turbo", "supercharger", "none"];

export function carsRouter(pool: Pool): Router {
  const r = Router();

  r.get("/engine-profiles", async (_req, res) => {
    const { rows } = await pool.query("SELECT * FROM engine_profiles ORDER BY label");
    res.json(rows);
  });

  // Registry-driven create-car flow (SPEC §4). Seeds engine snapshot + config from the profile,
  // then applies any caller overrides. Validation at the trust boundary is not skipped.
  r.post("/cars", async (req, res) => {
    const { name, engine_profile_id, forced_induction, config: overrides } = req.body ?? {};
    if (typeof name !== "string" || name.trim() === "")
      return res.status(400).json({ error: "name required" });
    if (typeof engine_profile_id !== "string")
      return res.status(400).json({ error: "engine_profile_id required" });

    const fi: ForcedInduction = {
      enabled: Boolean(forced_induction?.enabled),
      type: forced_induction?.type ?? "none",
    };
    if (!INDUCTION_TYPES.includes(fi.type))
      return res.status(400).json({ error: `forced_induction.type must be one of ${INDUCTION_TYPES.join(", ")}` });
    if (overrides !== undefined && (typeof overrides !== "object" || overrides === null))
      return res.status(400).json({ error: "config must be an object" });

    const { rows } = await pool.query<EngineProfile>(
      "SELECT * FROM engine_profiles WHERE id = $1", [engine_profile_id],
    );
    const profile = rows[0];
    if (!profile) return res.status(400).json({ error: `unknown engine_profile_id: ${engine_profile_id}` });

    const config = { ...seedConfig(profile, fi), ...(overrides ?? {}) };
    const inserted = await pool.query(
      `INSERT INTO cars (name, engine_profile_id, engine_label, ecu, forced_induction_json, config_json)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name.trim(), profile.id, profile.label, profile.ecu_default, fi, JSON.stringify(config)],
    );
    res.status(201).json(inserted.rows[0]);
  });

  r.get("/cars", async (_req, res) => {
    const { rows } = await pool.query("SELECT * FROM cars ORDER BY created_at DESC");
    res.json(rows);
  });

  r.get("/cars/:id", async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM cars WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "car not found" });
    res.json(rows[0]);
  });

  // Merge-patch the config (SPEC: everything editable post-creation).
  r.patch("/cars/:id/config", async (req, res) => {
    const patch = req.body;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch))
      return res.status(400).json({ error: "body must be a config object" });
    const { rows } = await pool.query(
      `UPDATE cars SET config_json = config_json || $2::jsonb WHERE id = $1 RETURNING *`,
      [req.params.id, JSON.stringify(patch)],
    );
    if (!rows[0]) return res.status(404).json({ error: "car not found" });
    res.json(rows[0]);
  });

  return r;
}
