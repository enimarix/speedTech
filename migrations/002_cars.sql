-- M1: cars own all their sessions (SPEC §4/§9). Config + induction are JSONB (fully editable).
CREATE TABLE IF NOT EXISTS cars (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  engine_profile_id     text NOT NULL REFERENCES engine_profiles(id),
  engine_label          text NOT NULL,   -- snapshot of the profile label at creation (editable)
  ecu                   text NOT NULL,
  forced_induction_json jsonb NOT NULL,   -- { enabled: bool, type: turbo|supercharger|none }
  config_json           jsonb NOT NULL,   -- seeded from profile + induction, all overridable
  created_at            timestamptz NOT NULL DEFAULT now()
);
