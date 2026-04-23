import type { CalendarClient, EventCreateBody } from "./calendar.ts";
import type { NotionService, NotionTask } from "./notion.ts";
import {
  type Database,
  deleteSyncedTaskByPageId,
  getSyncedTaskByPageId,
  upsertSyncedTask,
} from "./db.ts";
import { logger } from "./logger.ts";

const MAX_CAPTURED_ERRORS = 5;

export interface SyncN2GConfig {
  defaultEventDurationMin: number;
  timezone: string;
  // Google Calendar event color id (1–24). Applied on create + update so
  // events stay visually consistent.
  eventColorId?: string | null;
}

export interface SyncN2GStats {
  seen: number;
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
}

export interface SyncTaskN2GParams {
  db: Database;
  calendar: CalendarClient;
  config: SyncN2GConfig;
  now?: () => Date;
}

export interface SyncN2GParams extends SyncTaskN2GParams {
  notion: NotionService;
  sinceIso: string;
}

export function addDaysToYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMinutesToIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setTime(d.getTime() + minutes * 60_000);
  return d.toISOString();
}

export function buildEventBodyFromTask(
  task: NotionTask,
  cfg: SyncN2GConfig,
): EventCreateBody {
  const common: Pick<
    EventCreateBody,
    "summary" | "description" | "extendedProperties" | "colorId"
  > = {
    summary: task.title,
    description: `Source Notion: ${task.url}`,
    extendedProperties: { private: { notion_page_id: task.pageId } },
  };
  if (cfg.eventColorId) common.colorId = cfg.eventColorId;

  if (task.isAllDay) {
    // Google all-day events use an exclusive end.date — a one-day event on
    // April 21 is start=2026-04-21, end=2026-04-22.
    const endInclusive = task.dateEnd ?? task.dateStart;
    return {
      ...common,
      start: { date: task.dateStart },
      end: { date: addDaysToYmd(endInclusive, 1) },
    };
  }

  const endIso = task.dateEnd ??
    addMinutesToIso(task.dateStart, cfg.defaultEventDurationMin);
  return {
    ...common,
    start: { dateTime: task.dateStart, timeZone: cfg.timezone },
    end: { dateTime: endIso, timeZone: cfg.timezone },
  };
}

function emptyStats(): SyncN2GStats {
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

export async function runSyncN2G(params: SyncN2GParams): Promise<SyncN2GStats> {
  const stats = emptyStats();
  const tasks = await params.notion.queryTasksSince(params.sinceIso);
  logger.info("n2g_query", { found: tasks.length, since: params.sinceIso });

  for (const task of tasks) {
    stats.seen++;
    try {
      await syncTaskN2G(task, params, stats);
    } catch (err) {
      const message = (err as Error).message;
      stats.errors++;
      if (stats.errorMessages.length < MAX_CAPTURED_ERRORS) {
        stats.errorMessages.push(`page=${task.pageId}: ${message}`);
      }
      logger.error("n2g_error", { page: task.pageId, error: message });
    }
  }

  return stats;
}

// Exported for reconcile (§8.7 step 4 — re-apply N→G logic on each visible
// page). Caller owns the try/catch and stats accumulation.
export async function syncTaskN2G(
  task: NotionTask,
  params: SyncTaskN2GParams,
  stats: SyncN2GStats,
): Promise<void> {
  const { db, calendar, config } = params;
  const nowIso = (params.now ? params.now() : new Date()).toISOString();

  // (a) Archived or no owner — delete (if tracked) or skip.
  if (task.isArchived || !task.ownerEmail) {
    const existing = getSyncedTaskByPageId(db, task.pageId);
    if (existing) {
      await calendar.deleteEvent(existing.googleCalendarId, existing.googleEventId);
      deleteSyncedTaskByPageId(db, task.pageId);
      stats.deleted++;
      logger.info("n2g_event_deleted", {
        page: task.pageId,
        user: existing.googleCalendarId,
        event: existing.googleEventId,
        reason: task.isArchived ? "archived" : "no_owner",
      });
    } else {
      stats.skipped++;
      logger.debug("n2g_skip_archived_or_no_owner", { page: task.pageId });
    }
    return;
  }

  const ownerEmail = task.ownerEmail;
  const body = buildEventBodyFromTask(task, config);
  const row = getSyncedTaskByPageId(db, task.pageId);

  // (b.1) No row — safety net lookup via privateExtendedProperty, else create.
  if (!row) {
    const existing = await calendar.findByNotionPageId(ownerEmail, task.pageId);
    if (existing) {
      const patched = await calendar.patchEvent(ownerEmail, existing.id, body);
      upsertSyncedTask(db, {
        notionPageId: task.pageId,
        googleEventId: existing.id,
        googleCalendarId: ownerEmail,
        source: "notion",
        notionLastEditedAt: task.lastEditedAt,
        googleUpdatedAt: patched.updated,
        lastSyncedAt: nowIso,
        title: task.title,
      });
      stats.updated++;
      logger.info("n2g_event_rebound", {
        page: task.pageId,
        user: ownerEmail,
        event: existing.id,
      });
      return;
    }
    const created = await calendar.createEvent(ownerEmail, body);
    upsertSyncedTask(db, {
      notionPageId: task.pageId,
      googleEventId: created.id,
      googleCalendarId: ownerEmail,
      source: "notion",
      notionLastEditedAt: task.lastEditedAt,
      googleUpdatedAt: created.updated,
      lastSyncedAt: nowIso,
      title: task.title,
    });
    stats.created++;
    logger.info("n2g_event_created", {
      page: task.pageId,
      user: ownerEmail,
      event: created.id,
      title: task.title,
    });
    return;
  }

  // (b.2) Owner changed — delete on old calendar, create on new.
  if (row.googleCalendarId !== ownerEmail) {
    await calendar.deleteEvent(row.googleCalendarId, row.googleEventId);
    const created = await calendar.createEvent(ownerEmail, body);
    upsertSyncedTask(db, {
      notionPageId: task.pageId,
      googleEventId: created.id,
      googleCalendarId: ownerEmail,
      source: "notion",
      notionLastEditedAt: task.lastEditedAt,
      googleUpdatedAt: created.updated,
      lastSyncedAt: nowIso,
      title: task.title,
    });
    stats.moved++;
    logger.info("n2g_event_moved", {
      page: task.pageId,
      from: row.googleCalendarId,
      to: ownerEmail,
      event: created.id,
    });
    return;
  }

  // (b.3) Same owner — patch.
  const patched = await calendar.patchEvent(ownerEmail, row.googleEventId, body);
  upsertSyncedTask(db, {
    notionPageId: task.pageId,
    googleEventId: row.googleEventId,
    googleCalendarId: row.googleCalendarId,
    source: row.source,
    notionLastEditedAt: task.lastEditedAt,
    googleUpdatedAt: patched.updated,
    lastSyncedAt: nowIso,
    title: task.title,
  });
  stats.updated++;
  logger.info("n2g_event_updated", {
    page: task.pageId,
    user: ownerEmail,
    event: row.googleEventId,
  });
}
