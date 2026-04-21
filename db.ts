import { Database } from "@db/sqlite";

export { Database };

export type SyncSource = "notion" | "google";
export type SyncMode = "incremental" | "reconcile";
export type RunStatus = "running" | "success" | "failed";

export interface SyncedTask {
  notionPageId: string;
  googleEventId: string;
  googleCalendarId: string;
  source: SyncSource;
  notionLastEditedAt: string;
  googleUpdatedAt: string | null;
  lastSyncedAt: string;
  title: string | null;
}

export interface SyncRunStats {
  n2gSeen: number;
  n2gCreated: number;
  n2gUpdated: number;
  n2gMoved: number;
  n2gDeleted: number;
  n2gSkipped: number;
  g2nSeen: number;
  g2nCreated: number;
  g2nUpdated: number;
  g2nDeleted: number;
  g2nSkipped: number;
  errors: number;
}

export interface SyncRun {
  id: number;
  mode: SyncMode;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  stats: SyncRunStats;
  errorDetail: string | null;
}

export function createEmptyStats(): SyncRunStats {
  return {
    n2gSeen: 0,
    n2gCreated: 0,
    n2gUpdated: 0,
    n2gMoved: 0,
    n2gDeleted: 0,
    n2gSkipped: 0,
    g2nSeen: 0,
    g2nCreated: 0,
    g2nUpdated: 0,
    g2nDeleted: 0,
    g2nSkipped: 0,
    errors: 0,
  };
}

interface SyncedTaskRow {
  notion_page_id: string;
  google_event_id: string;
  google_calendar_id: string;
  source: SyncSource;
  notion_last_edited_at: string;
  google_updated_at: string | null;
  last_synced_at: string;
  title: string | null;
}

interface SyncRunRow {
  id: number;
  mode: SyncMode;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  n2g_seen: number;
  n2g_created: number;
  n2g_updated: number;
  n2g_moved: number;
  n2g_deleted: number;
  n2g_skipped: number;
  g2n_seen: number;
  g2n_created: number;
  g2n_updated: number;
  g2n_deleted: number;
  g2n_skipped: number;
  errors: number;
  error_detail: string | null;
}

function rowToSyncedTask(row: SyncedTaskRow): SyncedTask {
  return {
    notionPageId: row.notion_page_id,
    googleEventId: row.google_event_id,
    googleCalendarId: row.google_calendar_id,
    source: row.source,
    notionLastEditedAt: row.notion_last_edited_at,
    googleUpdatedAt: row.google_updated_at,
    lastSyncedAt: row.last_synced_at,
    title: row.title,
  };
}

function rowToSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    mode: row.mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    stats: {
      n2gSeen: row.n2g_seen,
      n2gCreated: row.n2g_created,
      n2gUpdated: row.n2g_updated,
      n2gMoved: row.n2g_moved,
      n2gDeleted: row.n2g_deleted,
      n2gSkipped: row.n2g_skipped,
      g2nSeen: row.g2n_seen,
      g2nCreated: row.g2n_created,
      g2nUpdated: row.g2n_updated,
      g2nDeleted: row.g2n_deleted,
      g2nSkipped: row.g2n_skipped,
      errors: row.errors,
    },
    errorDetail: row.error_detail,
  };
}

const MIGRATIONS_URL = new URL("./migrations.sql", import.meta.url);

export function openDatabase(path: string): Database {
  const db = new Database(path);
  const sql = Deno.readTextFileSync(MIGRATIONS_URL);
  db.exec(sql);
  return db;
}

// -- synced_tasks -----------------------------------------------------------

export function getSyncedTaskByPageId(db: Database, pageId: string): SyncedTask | null {
  const row = db
    .prepare("SELECT * FROM synced_tasks WHERE notion_page_id = ?")
    .get<SyncedTaskRow>(pageId);
  return row ? rowToSyncedTask(row) : null;
}

export function getSyncedTaskByEventId(db: Database, eventId: string): SyncedTask | null {
  const row = db
    .prepare("SELECT * FROM synced_tasks WHERE google_event_id = ?")
    .get<SyncedTaskRow>(eventId);
  return row ? rowToSyncedTask(row) : null;
}

export function listSyncedTasks(db: Database): SyncedTask[] {
  const rows = db.prepare("SELECT * FROM synced_tasks").all<SyncedTaskRow>();
  return rows.map(rowToSyncedTask);
}

export function upsertSyncedTask(db: Database, task: SyncedTask): void {
  db.prepare(
    `INSERT INTO synced_tasks (
      notion_page_id, google_event_id, google_calendar_id, source,
      notion_last_edited_at, google_updated_at, last_synced_at, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(notion_page_id) DO UPDATE SET
      google_event_id = excluded.google_event_id,
      google_calendar_id = excluded.google_calendar_id,
      source = excluded.source,
      notion_last_edited_at = excluded.notion_last_edited_at,
      google_updated_at = excluded.google_updated_at,
      last_synced_at = excluded.last_synced_at,
      title = excluded.title`,
  ).run(
    task.notionPageId,
    task.googleEventId,
    task.googleCalendarId,
    task.source,
    task.notionLastEditedAt,
    task.googleUpdatedAt,
    task.lastSyncedAt,
    task.title,
  );
}

export function deleteSyncedTaskByPageId(db: Database, pageId: string): void {
  db.prepare("DELETE FROM synced_tasks WHERE notion_page_id = ?").run(pageId);
}

// -- google_sync_tokens -----------------------------------------------------

export function getSyncToken(db: Database, calendarId: string): string | null {
  const row = db
    .prepare("SELECT sync_token FROM google_sync_tokens WHERE calendar_id = ?")
    .get<{ sync_token: string }>(calendarId);
  return row ? row.sync_token : null;
}

export function upsertSyncToken(db: Database, calendarId: string, token: string): void {
  db.prepare(
    `INSERT INTO google_sync_tokens (calendar_id, sync_token, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(calendar_id) DO UPDATE SET
       sync_token = excluded.sync_token,
       updated_at = excluded.updated_at`,
  ).run(calendarId, token, new Date().toISOString());
}

export function deleteSyncToken(db: Database, calendarId: string): void {
  db.prepare("DELETE FROM google_sync_tokens WHERE calendar_id = ?").run(calendarId);
}

// -- sync_runs --------------------------------------------------------------

export function startSyncRun(db: Database, mode: SyncMode): number {
  db.prepare(
    `INSERT INTO sync_runs (mode, started_at, status) VALUES (?, ?, 'running')`,
  ).run(mode, new Date().toISOString());
  return Number(db.lastInsertRowId);
}

export function finishSyncRun(
  db: Database,
  id: number,
  stats: SyncRunStats,
  status: "success" | "failed",
  errorDetail: string | null = null,
): void {
  db.prepare(
    `UPDATE sync_runs SET
       ended_at = ?, status = ?,
       n2g_seen = ?, n2g_created = ?, n2g_updated = ?, n2g_moved = ?,
       n2g_deleted = ?, n2g_skipped = ?,
       g2n_seen = ?, g2n_created = ?, g2n_updated = ?,
       g2n_deleted = ?, g2n_skipped = ?,
       errors = ?, error_detail = ?
     WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    status,
    stats.n2gSeen,
    stats.n2gCreated,
    stats.n2gUpdated,
    stats.n2gMoved,
    stats.n2gDeleted,
    stats.n2gSkipped,
    stats.g2nSeen,
    stats.g2nCreated,
    stats.g2nUpdated,
    stats.g2nDeleted,
    stats.g2nSkipped,
    stats.errors,
    errorDetail,
    id,
  );
}

export function getLastSuccessfulRun(db: Database, mode: SyncMode): SyncRun | null {
  const row = db
    .prepare(
      `SELECT * FROM sync_runs
       WHERE status = 'success' AND mode = ?
       ORDER BY ended_at DESC LIMIT 1`,
    )
    .get<SyncRunRow>(mode);
  return row ? rowToSyncRun(row) : null;
}

// -- meta -------------------------------------------------------------------

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>(key);
  return row ? row.value : null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
