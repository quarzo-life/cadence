import type { CalendarClient } from "./calendar.ts";
import type { NotionService, NotionUser } from "./notion.ts";
import {
  type Database,
  deleteSyncedTaskByPageId,
  listSyncedTasks,
  type SyncedTask,
  type SyncRunStats,
  upsertSyncedTask,
} from "./db.ts";
import { logger } from "./logger.ts";
import { buildNotionDateFromEvent } from "./sync-g2n.ts";
import {
  syncTaskN2G,
  type SyncN2GConfig,
  type SyncN2GStats,
} from "./sync-n2g.ts";

const MAX_CAPTURED_ERRORS = 5;

export interface ReconcileConfig {
  n2g: SyncN2GConfig;
  timezone: string;
}

export interface ReconcileParams {
  db: Database;
  notion: NotionService;
  calendar: CalendarClient;
  config: ReconcileConfig;
  now?: () => Date;
}

export interface ReconcileResult {
  stats: SyncRunStats;
  errorMessages: string[];
}

function emptyRunStats(): SyncRunStats {
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

function emptyN2GStats(): SyncN2GStats {
  return {
    seen: 0,
    created: 0,
    updated: 0,
    moved: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
  };
}

export async function runReconcile(params: ReconcileParams): Promise<ReconcileResult> {
  const { db, notion, config } = params;
  const nowFn = params.now ?? (() => new Date());
  const nowIso = nowFn().toISOString();

  const stats = emptyRunStats();
  const errorMessages: string[] = [];

  logger.info("reconcile_start", {});

  // §8.7 step 1-2 — full Notion scan → visible set.
  const tasks = await notion.queryAllTasks();
  const visiblePageIds = new Set<string>();
  for (const t of tasks) visiblePageIds.add(t.pageId);
  logger.info("reconcile_notion_scan", { visible: visiblePageIds.size });

  // Resolve emails once for source='google' orphan reingestion.
  const users = await notion.listUsers();
  const userByEmail = new Map<string, NotionUser>();
  for (const u of users) if (u.email) userByEmail.set(u.email, u);

  // §8.7 step 3 — orphan rows (pageId missing from current Notion snapshot).
  const rows = listSyncedTasks(db);
  for (const row of rows) {
    if (visiblePageIds.has(row.notionPageId)) continue;
    try {
      await handleOrphan(row, params, userByEmail, stats, nowIso);
    } catch (err) {
      const message = (err as Error).message;
      stats.errors++;
      if (errorMessages.length < MAX_CAPTURED_ERRORS) {
        errorMessages.push(`orphan page=${row.notionPageId}: ${message}`);
      }
      logger.error("reconcile_error", {
        phase: "orphan",
        page: row.notionPageId,
        error: message,
      });
    }
  }

  // §8.7 step 4 — re-apply N→G on every currently visible page.
  const n2gStats = emptyN2GStats();
  const n2gParams = {
    db,
    calendar: params.calendar,
    config: config.n2g,
    now: nowFn,
  };
  for (const task of tasks) {
    n2gStats.seen++;
    try {
      await syncTaskN2G(task, n2gParams, n2gStats);
    } catch (err) {
      const message = (err as Error).message;
      n2gStats.errors++;
      if (errorMessages.length < MAX_CAPTURED_ERRORS) {
        errorMessages.push(`n2g_apply page=${task.pageId}: ${message}`);
      }
      logger.error("reconcile_error", {
        phase: "n2g_apply",
        page: task.pageId,
        error: message,
      });
    }
  }

  stats.n2gSeen += n2gStats.seen;
  stats.n2gCreated += n2gStats.created;
  stats.n2gUpdated += n2gStats.updated;
  stats.n2gMoved += n2gStats.moved;
  stats.n2gDeleted += n2gStats.deleted;
  stats.n2gSkipped += n2gStats.skipped;
  stats.errors += n2gStats.errors;

  logger.info("reconcile_end", {
    n2g_created: stats.n2gCreated,
    n2g_updated: stats.n2gUpdated,
    n2g_moved: stats.n2gMoved,
    n2g_deleted: stats.n2gDeleted,
    g2n_created: stats.g2nCreated,
    g2n_deleted: stats.g2nDeleted,
    errors: stats.errors,
  });

  return { stats, errorMessages };
}

async function handleOrphan(
  row: SyncedTask,
  params: ReconcileParams,
  userByEmail: Map<string, NotionUser>,
  stats: SyncRunStats,
  nowIso: string,
): Promise<void> {
  const { db, calendar, notion, config } = params;

  if (row.source === "notion") {
    await calendar.deleteEvent(row.googleCalendarId, row.googleEventId);
    deleteSyncedTaskByPageId(db, row.notionPageId);
    stats.n2gDeleted++;
    logger.info("reconcile_orphan_notion_deleted", {
      page: row.notionPageId,
      event: row.googleEventId,
      user: row.googleCalendarId,
    });
    return;
  }

  // source === 'google' — Notion mirror was hard-deleted. The authoritative
  // source is Google; try to recreate the Notion page from the live event.
  const event = await calendar.getEvent(row.googleCalendarId, row.googleEventId);
  if (!event || event.status === "cancelled") {
    deleteSyncedTaskByPageId(db, row.notionPageId);
    stats.g2nDeleted++;
    logger.info("reconcile_orphan_google_dropped", {
      page: row.notionPageId,
      event: row.googleEventId,
      user: row.googleCalendarId,
    });
    return;
  }

  const user = userByEmail.get(row.googleCalendarId);
  if (!user) {
    deleteSyncedTaskByPageId(db, row.notionPageId);
    stats.g2nDeleted++;
    logger.warn("reconcile_orphan_owner_missing", {
      page: row.notionPageId,
      event: row.googleEventId,
      email: row.googleCalendarId,
    });
    return;
  }

  const { dateStart, dateEnd, isAllDay, timezone } = buildNotionDateFromEvent(
    event,
    config.timezone,
  );
  // The event was previously linked, so summary is already the clean title —
  // no keyword strip needed.
  const title = event.summary ?? "";

  const created = await notion.createTaskPage({
    title,
    dateStart,
    dateEnd,
    isAllDay,
    ownerUserId: user.id,
    timezone,
  });

  const sealed = await calendar.patchEvent(row.googleCalendarId, row.googleEventId, {
    summary: title,
    extendedProperties: { private: { notion_page_id: created.pageId } },
  });

  // notion_page_id is the PK — drop the stale row, insert the fresh one.
  deleteSyncedTaskByPageId(db, row.notionPageId);
  upsertSyncedTask(db, {
    notionPageId: created.pageId,
    googleEventId: row.googleEventId,
    googleCalendarId: row.googleCalendarId,
    source: "google",
    notionLastEditedAt: created.lastEditedAt,
    googleUpdatedAt: sealed.updated,
    lastSyncedAt: nowIso,
    title,
  });
  stats.g2nCreated++;
  logger.info("reconcile_orphan_google_recreated", {
    old_page: row.notionPageId,
    new_page: created.pageId,
    event: row.googleEventId,
  });
}
