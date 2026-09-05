-- M0: engine/ECU registry (SPEC §4). Data, not code — new builds are new rows.
CREATE TABLE IF NOT EXISTS engine_profiles (
  id              text PRIMARY KEY,   -- slug, e.g. m50b25_m52head
  label           text NOT NULL,
  displacement_cc integer NOT NULL,
  cylinders       integer NOT NULL,
  ecu_default     text NOT NULL,
  redline_default integer NOT NULL,
  axes_json       jsonb NOT NULL,     -- { rpm_axis_default: number[], load_axis_default: number[] }
  notes           text
);

-- Seed: the target car for the first build (SPEC §4).
-- ponytail: axes are starting-point defaults; the create-car flow overrides them per car.
INSERT INTO engine_profiles
  (id, label, displacement_cc, cylinders, ecu_default, redline_default, axes_json, notes)
VALUES (
  'm50b25_m52head',
  'M50 block + M52 head',
  2494,
  6,
  'MS41.1',
  6500,
  '{"rpm_axis_default":[800,1200,1600,2000,2500,3000,3500,4000,4500,5000,5500,6000,6500],"load_axis_default":[40,80,120,160,200,240,280,320,360,400]}',
  'BMW hybrid: M50 block, M52 head, Siemens MS41 ECU. Target car for the first build.'
)
ON CONFLICT (id) DO NOTHING;
