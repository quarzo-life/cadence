import type { CalendarClient, CalendarEvent, ListParams } from "./calendar.ts";
import { SyncTokenExpiredError } from "./calendar.ts";
import type { NotionService, NotionUser } from "./notion.ts";
import {
  type Database,
  deleteSyncedTaskByPageId,
  deleteSyncToken,
  getSyncedTaskByEventId,
  getSyncToken,
  upsertSyncedTask,
  upsertSyncToken,
} from "./db.ts";
import { logger } from "./logger.ts";
import { addDaysToYmd } from "./sync-n2g.ts";

// Initial seed window for the first events.list call on a calendar — user
// override of SPEC §8.6/§10 (30j/365j → 10j/10j). Decision logged in memory.
export const SEED_LOOKBACK_DAYS = 10;
export const SEED_LOOKAHEAD_DAYS = 10;
const MAX_CAPTURED_ERRORS = 5;

export interface SyncG2NConfig {
  watchEmails: string[];
  syncKeyword: string;
  timezone: string;
}

export interface SyncG2NStats {
  seen: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
}

export interface SyncG2NParams {
  db: Database;
  notion: NotionService;
  calendar: CalendarClient;
  config: SyncG2NConfig;
  now?: () => Date;
}

export function matchKeyword(keyword: string, summary: string | undefined): string | null {
  if (!summary) return null;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Spec §8.8 writes the separator alternation as (\s+|\s*[:\-–—]\s*). We flip
  // the branches so the punctuated form wins over a plain whitespace match —
  // otherwise "NOTION - bla" captures "- bla" instead of the intended "bla".
  const re = new RegExp(`^\\s*${escaped}(\\s*[:\\-–—]\\s*|\\s+)(.+)$`, "i");
  const m = re.exec(summary);
  if (!m) return null;
  const body = m[2].trim();
  return body.length > 0 ? body : null;
}

export function buildNotionDateFromEvent(
  event: CalendarEvent,
  fallbackTimezone: string,
): {
  dateStart: string;
  dateEnd: string | null;
  isAllDay: boolean;
  timezone: string;
} {
  if (event.start.date && event.end.date) {
    const startYmd = event.start.date;
    const endExclusive = event.end.date;
    const endInclusive = addDaysToYmd(endExclusive, -1);
    const dateEnd = endInclusive === startYmd ? null : endInclusive;
    return { dateStart: startYmd, dateEnd, isAllDay: true, timezone: fallbackTimezone };
  }
  const start = event.start.dateTime ?? "";
  const end = event.end.dateTime ?? null;
  // §8.13: if Google carries timeZone, respect it; otherwise fall back.
  const timezone = event.start.timeZone ?? fallbackTimezone;
  return { dateStart: start, dateEnd: end, isAllDay: false, timezone };
}

function emptyStats(): SyncG2NStats {
  return {
    seen: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
  };
}

export async function runSyncG2N(params: SyncG2NParams): Promise<SyncG2NStats> {
  const stats = emptyStats();
  const { config } = params;

  if (config.watchEmails.length === 0) {
    logger.debug("g2n_disabled", { reason: "empty GOOGLE_WATCH_EMAILS" });
    return stats;
  }

  const users = await params.notion.listUsers();
  const userByEmail = new Map<string, NotionUser>();
  for (const u of users) {
    if (u.email) userByEmail.set(u.email, u);
  }

  for (const email of config.watchEmails) {
    try {
      await syncOneCalendar(email, userByEmail, params, stats);
    } catch (err) {
      const message = (err as Error).message;
      stats.errors++;
      if (stats.errorMessages.length < MAX_CAPTURED_ERRORS) {
        stats.errorMessages.push(`calendar=${email}: ${message}`);
      }
      logger.error("g2n_error", { calendar: email, error: message });
    }
  }

  return stats;
}

async function syncOneCalendar(
  email: string,
  userByEmail: Map<string, NotionUser>,
  params: SyncG2NParams,
  stats: SyncG2NStats,
): Promise<void> {
  const { db, calendar } = params;
  const now = params.now ? params.now() : new Date();

  function seedParams(): ListParams {
    const timeMin = new Date(
      now.getTime() - SEED_LOOKBACK_DAYS * 86_400_000,
    ).toISOString();
    const timeMax = new Date(
      now.getTime() + SEED_LOOKAHEAD_DAYS * 86_400_000,
    ).toISOString();
    return { timeMin, timeMax };
  }

  const existingToken = getSyncToken(db, email);
  logger.info("g2n_query_start", {
    email,
    has_sync_token: existingToken !== null,
  });

  let result: { events: CalendarEvent[]; nextSyncToken: string | null };
  try {
    result = await calendar.listAll(
      email,
      existingToken ? { syncToken: existingToken } : seedParams(),
    );
  } catch (err) {
    if (err instanceof SyncTokenExpiredError) {
      logger.warn("g2n_sync_token_expired", { email });
      deleteSyncToken(db, email);
      result = await calendar.listAll(email, seedParams());
    } else {
      throw err;
    }
  }

  for (const event of result.events) {
    stats.seen++;
    try {
      await ingestOneEvent(event, email, userByEmail, params, stats);
    } catch (err) {
      const message = (err as Error).message;
      stats.errors++;
      if (stats.errorMessages.length < MAX_CAPTURED_ERRORS) {
        stats.errorMessages.push(`event=${event.id} calendar=${email}: ${message}`);
      }
      logger.error("g2n_error", { email, event: event.id, error: message });
    }
  }

  if (result.nextSyncToken) {
    upsertSyncToken(db, email, result.nextSyncToken);
  }
}

async function ingestOneEvent(
  event: CalendarEvent,
  email: string,
  userByEmail: Map<string, NotionUser>,
  params: SyncG2NParams,
  stats: SyncG2NStats,
): Promise<void> {
  const { db, calendar, notion, config } = params;
  const nowIso = (params.now ? params.now() : new Date()).toISOString();

  // (a) cancelled — archive linked Notion page, drop the row.
  if (event.status === "cancelled") {
    const row = getSyncedTaskByEventId(db, event.id);
    if (!row) {
      stats.skipped++;
      return;
    }
    await notion.archiveTaskPage(row.notionPageId);
    deleteSyncedTaskByPageId(db, row.notionPageId);
    stats.deleted++;
    logger.info("g2n_event_archived", {
      email,
      event: event.id,
      notion_page: row.notionPageId,
    });
    return;
  }

  // (b) event originates from Notion — never ingest (§8.9).
  const notionOriginId = event.extendedProperties?.private?.notion_page_id;
  if (notionOriginId) {
    stats.skipped++;
    logger.debug("g2n_skip_notion_origin", {
      email,
      event: event.id,
      notion_page: notionOriginId,
    });
    return;
  }

  const row = getSyncedTaskByEventId(db, event.id);

  // (c.1) no row → keyword test for initial ingestion only.
  if (!row) {
    const title = matchKeyword(config.syncKeyword, event.summary);
    if (title === null) {
      stats.skipped++;
      return;
    }
    const user = userByEmail.get(email);
    if (!user) {
      stats.skipped++;
      logger.warn("g2n_owner_not_found", { email, event: event.id });
      return;
    }
    const { dateStart, dateEnd, isAllDay, timezone } = buildNotionDateFromEvent(
      event,
      config.timezone,
    );
    const created = await notion.createTaskPage({
      title,
      dateStart,
      dateEnd,
      isAllDay,
      ownerUserId: user.id,
      timezone,
    });

    // Immediately seal the event — prevents re-ingestion even if the SQLite
    // insert below fails. Order matters (CLAUDE.md).
    const sealed = await calendar.patchEvent(email, event.id, {
      summary: title,
      extendedProperties: { private: { notion_page_id: created.pageId } },
    });

    upsertSyncedTask(db, {
      notionPageId: created.pageId,
      googleEventId: event.id,
      googleCalendarId: email,
      source: "google",
      notionLastEditedAt: created.lastEditedAt,
      googleUpdatedAt: sealed.updated,
      lastSyncedAt: nowIso,
      title,
    });
    stats.created++;
    logger.info("g2n_page_created", {
      email,
      event: event.id,
      notion_page: created.pageId,
      title,
    });
    logger.info("g2n_event_sealed", {
      email,
      event: event.id,
      notion_page: created.pageId,
    });
    return;
  }

  // (c.2) row exists — only update if Google has a newer mtime than ours
  // (otherwise it's our own N→G echo, §8.9).
  if (row.googleUpdatedAt && event.updated <= row.googleUpdatedAt) {
    stats.skipped++;
    return;
  }

  const { dateStart, dateEnd, isAllDay, timezone } = buildNotionDateFromEvent(
    event,
    config.timezone,
  );
  // Once linked, the title follows Google's summary verbatim — no keyword
  // re-matching (§8.9).
  const title = event.summary ?? "";
  const updated = await notion.updateTaskPage({
    pageId: row.notionPageId,
    title,
    dateStart,
    dateEnd,
    isAllDay,
    timezone,
  });
  upsertSyncedTask(db, {
    notionPageId: row.notionPageId,
    googleEventId: row.googleEventId,
    googleCalendarId: row.googleCalendarId,
    source: row.source,
    notionLastEditedAt: updated.lastEditedAt,
    googleUpdatedAt: event.updated,
    lastSyncedAt: nowIso,
    title,
  });
  stats.updated++;
  logger.info("g2n_page_updated", {
    email,
    event: event.id,
    notion_page: row.notionPageId,
  });
}
