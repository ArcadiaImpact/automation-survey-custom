-- One current row per response. started_at never changes after insert;
-- submitted_at keeps its first value. Timestamps are ISO 8601 UTC text.
CREATE TABLE IF NOT EXISTS responses (
  response_id         TEXT PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
  revision            INTEGER NOT NULL,
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  submitted_at        TEXT,
  last_completed_step INTEGER NOT NULL,
  content_version     TEXT NOT NULL,
  client_updated_at   TEXT NOT NULL,
  raw_json            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS responses_status_updated ON responses (status, updated_at);

-- Append-only log of accepted writes. id is the mirror's cursor.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at    TEXT NOT NULL,
  response_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  UNIQUE (response_id, revision)
);
