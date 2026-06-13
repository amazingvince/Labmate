-- Labmate evidence ledger (Cloudflare D1 / SQLite).
-- Apply with: npx wrangler d1 execute labmate --file=./schema.sql
-- This is the heart of the product: not just metrics, but what the agent believed,
-- why it acted, what evidence changed its mind, and what the human corrected.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS study (
  id              TEXT PRIMARY KEY,           -- study_<ulid>
  brief           TEXT NOT NULL,
  owner           TEXT,
  task_type       TEXT,                       -- 'binary_classification' | 'regression'
  dataset_id      TEXT NOT NULL,
  target          TEXT NOT NULL,
  metric          TEXT NOT NULL,
  metric_rationale TEXT,
  budget_json     TEXT,                       -- { max_trials, budget_seconds }
  rubric          TEXT DEFAULT 'docs/rubric.json',
  status          TEXT DEFAULT 'open',        -- open | done | stopped
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_version (
  id              TEXT PRIMARY KEY,
  study_id        TEXT NOT NULL REFERENCES study(id),
  file_hash       TEXT NOT NULL,
  row_count       INTEGER,
  schema_json     TEXT,
  target_definition TEXT,
  split_strategy  TEXT,                       -- 'time_based' | 'stratified'
  seed            INTEGER,
  leakage_candidates_json TEXT,               -- ["resolved_at", ...]
  banned_columns_json     TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hypothesis (
  id              TEXT PRIMARY KEY,           -- hyp_<ulid>
  study_id        TEXT NOT NULL REFERENCES study(id),
  statement       TEXT NOT NULL,
  rationale       TEXT,
  model_family    TEXT,
  features_json   TEXT,
  expected_outcome TEXT,
  status          TEXT DEFAULT 'proposed',    -- proposed | approved | rejected
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_manifest (
  id              TEXT PRIMARY KEY,
  hypothesis_id   TEXT NOT NULL REFERENCES hypothesis(id),
  model_family    TEXT,
  features_json   TEXT,
  preprocessing_json TEXT,
  search_space_json  TEXT,
  seed            INTEGER,
  applied_feedback_id TEXT,                    -- which human feedback shaped this manifest
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id              TEXT PRIMARY KEY,           -- run_<ulid>
  study_id        TEXT NOT NULL REFERENCES study(id),
  hypothesis_id   TEXT REFERENCES hypothesis(id),
  manifest_id     TEXT REFERENCES experiment_manifest(id),
  tracker_run_id  TEXT,                       -- trackio run id
  status          TEXT DEFAULT 'queued',      -- queued | running | completed | failed
  metrics_json    TEXT,
  params_json     TEXT,
  artifacts_json  TEXT,
  rationale       TEXT,                       -- one line: what this run tests and why
  tags_json       TEXT,                       -- e.g. ["baseline"]
  executor        TEXT DEFAULT 'modal-runner',
  dataset_hash    TEXT,
  code_hash       TEXT,
  seed            INTEGER,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES run(id),
  kind            TEXT,                       -- 'confusion_matrix' | 'feature_importance' | 'cv_summary' | 'calibration'
  uri             TEXT,                       -- R2 object key
  summary_json    TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS critique (
  id              TEXT PRIMARY KEY,           -- crit_<ulid>
  study_id        TEXT NOT NULL REFERENCES study(id),
  target_run_id   TEXT REFERENCES run(id),
  kind            TEXT,                       -- 'leakage' | 'test_set_tuning' | 'metric' | 'calibration' | 'robustness'
  finding         TEXT,
  recommendation  TEXT,
  led_to_decision TEXT,                       -- 'promote' | 'reject' | 'rerun' | 'branch' | 'stop'
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision (
  id              TEXT PRIMARY KEY,           -- dec_<ulid>
  study_id        TEXT NOT NULL REFERENCES study(id),
  action          TEXT,                       -- promote | reject | rerun | branch | stop
  promoted_run_id TEXT REFERENCES run(id),
  rejected_run_id TEXT REFERENCES run(id),
  reason          TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id              TEXT PRIMARY KEY,
  study_id        TEXT NOT NULL REFERENCES study(id),
  target_id       TEXT,                       -- study | hypothesis | run
  type            TEXT,                       -- 'approval' | 'ban_feature' | 'change_metric' | 'increase_budget' | 'focus_segment' | 'note'
  scope           TEXT,
  content         TEXT,
  parsed_constraints_json TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id              TEXT PRIMARY KEY,
  study_id        TEXT REFERENCES study(id),
  kind            TEXT,                       -- 'dataset_fact' | 'known_pitfall' | 'preferred_metric' | 'banned_column'
  content         TEXT,
  created_at      TEXT NOT NULL
);

-- Indexes for the agent-native read path (query_runs filters).
CREATE INDEX IF NOT EXISTS idx_run_study   ON run(study_id);
CREATE INDEX IF NOT EXISTS idx_run_hyp     ON run(hypothesis_id);
CREATE INDEX IF NOT EXISTS idx_run_status  ON run(status);
CREATE INDEX IF NOT EXISTS idx_crit_study  ON critique(study_id);
CREATE INDEX IF NOT EXISTS idx_crit_kind   ON critique(kind);
CREATE INDEX IF NOT EXISTS idx_fb_study    ON feedback(study_id);
CREATE INDEX IF NOT EXISTS idx_hyp_study   ON hypothesis(study_id);
