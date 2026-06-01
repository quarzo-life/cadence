// One-shot fix script — re-applies N→G sync for all tasks last-synced today.
//
// Context: the old N→G code treated Notion naive-local datetimes as UTC on the
// Railway server (UTC system timezone), shifting every timed event by +2h in
// Google Calendar. Running this script after deploying the naiveLocalToUTC fix
// re-pushes the correct UTC times and restores Google Calendar.
//
// Usage:   deno run --allow-read --allow-env --allow-net fix-hour-shift.ts
// Dry-run: deno run --allow-read --allow-env --allow-net fix-hour-shift.ts --dry-run

import { Client as NotionClient } from "@notionhq/client";
import { loadConfig } from "./config.ts";
import { openDatabase, listSyncedTasks } from "./db.ts";
import { createGoogleAuth } from "./google-auth.ts";
import { createCalendarClient } from "./calendar.ts";
import { createNotionService } from "./notion.ts";
import { syncTaskN2G, type SyncN2GStats } from "./sync-n2g.ts";
import { logger } from "./logger.ts";

async function main(): Promise<number> {
  const dryRun = Deno.args.includes("--dry-run");

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`config error: ${(err as Error).message}`);
    return 1;
  }

  let db;
  try {
    db = openDatabase(cfg.database.path);
  } catch (err) {
    console.error(`database init failed: ${(err as Error).message}`);
    return 1;
  }

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const sinceIso = `${todayIso}T00:00:00.000Z`;

    const rows = listSyncedTasks(db);
    const affectedPageIds = new Set(
      rows
        .filter((r) => r.lastSyncedAt >= sinceIso)
        .map((r) => r.notionPageId),
    );

    logger.info("fix_hour_shift_start", {
      dry_run: dryRun,
      since: sinceIso,
      affected_rows: affectedPageIds.size,
    });

    if (affectedPageIds.size === 0) {
      logger.info("fix_hour_shift_nothing_to_do", {});
      return 0;
    }

    if (dryRun) {
      logger.info("fix_hour_shift_dry_run", {
        would_fix: affectedPageIds.size,
        page_ids: [...affectedPageIds].slice(0, 20),
      });
      return 0;
    }

    const notionClient = new NotionClient({ auth: cfg.notion.token });
    const auth = createGoogleAuth(cfg.google.saEmail, cfg.google.saPrivateKey);
    const calendar = createCalendarClient(auth);
    const notion = createNotionService(notionClient, {
      databaseId: cfg.notion.databaseId,
      schema: {
        propTitle: cfg.notion.propTitle,
        propDate: cfg.notion.propDate,
        propOwner: cfg.notion.propOwner,
        propStatus: cfg.notion.propStatus,
        statusArchivedValues: cfg.notion.statusArchivedValues,
      },
    });

    const allTasks = await notion.queryAllTasks();
    const toFix = allTasks.filter((t) => affectedPageIds.has(t.pageId));

    logger.info("fix_hour_shift_notion_scan", {
      notion_total: allTasks.length,
      to_fix: toFix.length,
    });

    const stats: SyncN2GStats = {
      seen: 0,
      created: 0,
      updated: 0,
      moved: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      errorMessages: [],
    };

    const n2gParams = {
      db,
      calendar,
      config: {
        defaultEventDurationMin: cfg.sync.defaultEventDurationMin,
        timezone: cfg.sync.timezone,
        eventColorId: cfg.sync.eventColorId,
      },
    };

    for (const task of toFix) {
      stats.seen++;
      try {
        await syncTaskN2G(task, n2gParams, stats);
        logger.debug("fix_hour_shift_task", { page: task.pageId, title: task.title });
      } catch (err) {
        stats.errors++;
        logger.error("fix_hour_shift_error", {
          page: task.pageId,
          title: task.title,
          error: (err as Error).message,
        });
      }
    }

    logger.info("fix_hour_shift_done", {
      seen: stats.seen,
      updated: stats.updated,
      skipped: stats.skipped,
      errors: stats.errors,
      error_messages: stats.errorMessages,
    });

    return stats.errors > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}
