-- M4: a session = one analyzed batch for a car (SPEC §5/§9).
-- ponytail: the full §6 analysis is stored as JSONB `derived` (the source of truth the UI/AI read),
-- not exploded into cell_maps/events/findings tables. Normalize later only if M5 trend queries need it.
CREATE TABLE IF NOT EXISTS sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id              uuid NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  label               text,
  baseline_session_id uuid REFERENCES sessions(id),
  derived             jsonb NOT NULL,
  headline            text
);

CREATE TABLE IF NOT EXISTS logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename         text NOT NULL,
  source_type      text NOT NULL,
  duration_s       double precision,
  row_count        integer,
  sample_rate_hz   double precision,
  present_channels text[] NOT NULL,
  dead_channels    text[] NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_car_idx ON sessions (car_id, uploaded_at DESC);
