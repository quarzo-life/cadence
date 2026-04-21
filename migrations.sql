-- Migrations — replayed on every boot. All statements are idempotent.

CREATE TABLE IF NOT EXISTS synced_tasks (
  notion_page_id        TEXT PRIMARY KEY,
  google_event_id       TEXT NOT NULL,
  google_calendar_id    TEXT NOT NULL,
  source                TEXT NOT NULL,
  notion_last_edited_at TEXT NOT NULL,
  google_updated_at     TEXT,
  last_synced_at        TEXT NOT NULL,
  title                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_synced_tasks_calendar
  ON synced_tasks(google_calendar_id);

CREATE INDEX IF NOT EXISTS idx_synced_tasks_event
  ON synced_tasks(google_event_id);

CREATE TABLE IF NOT EXISTS google_sync_tokens (
  calendar_id     TEXT PRIMARY KEY,
  sync_token      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mode            TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT NOT NULL,
  n2g_seen        INTEGER NOT NULL DEFAULT 0,
  n2g_created     INTEGER NOT NULL DEFAULT 0,
  n2g_updated     INTEGER NOT NULL DEFAULT 0,
  n2g_moved       INTEGER NOT NULL DEFAULT 0,
  n2g_deleted     INTEGER NOT NULL DEFAULT 0,
  n2g_skipped     INTEGER NOT NULL DEFAULT 0,
  g2n_seen        INTEGER NOT NULL DEFAULT 0,
  g2n_created     INTEGER NOT NULL DEFAULT 0,
  g2n_updated     INTEGER NOT NULL DEFAULT 0,
  g2n_deleted     INTEGER NOT NULL DEFAULT 0,
  g2n_skipped     INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  error_detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_ended_at
  ON sync_runs(ended_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
