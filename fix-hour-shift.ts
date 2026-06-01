// One-shot fix script — corrects the 2h shift introduced by the naiveLocalToUTC fix.
//
// Modes:
//   --dry-run   count affected rows, no API calls
//   --preview   show before/after times per event (slow: fetches Google for each)
//   --fix-all   fix BOTH cases:
//               (a) Notion correct + Google wrong → re-sync Notion→Google  [was default]
//               (b) Notion wrong + Google wrong   → add +2h to Notion, then push to Google
//   (no flag)   fix only case (a): re-sync Notion→Google for today's rows

import { Client as NotionClient } from "@notionhq/client";
import { loadConfig } from "./config.ts";
import { openDatabase, getSyncedTaskByPageId, listSyncedTasks } from "./db.ts";
import { createGoogleAuth } from "./google-auth.ts";
import { createCalendarClient } from "./calendar.ts";
import { createNotionService, type NotionTask } from "./notion.ts";
import { syncTaskN2G, buildEventBodyFromTask, type SyncN2GStats } from "./sync-n2g.ts";
import { logger } from "./logger.ts";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function toParisLocal(isoUtc: string): string {
  try {
    return new Date(isoUtc).toLocaleString("fr-FR", {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoUtc;
  }
}

function shiftIsoByTwoHours(iso: string): string {
  return new Date(new Date(iso).getTime() + TWO_HOURS_MS).toISOString();
}

// Two task.dateStart values are "the same time" if they differ by less than 1 minute.
function sameTime(a: string, b: string): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60_000;
}

async function main(): Promise<number> {
  const dryRun = Deno.args.includes("--dry-run");
  const preview = Deno.args.includes("--preview");
  const fixAll = Deno.args.includes("--fix-all");

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
      rows.filter((r) => r.lastSyncedAt >= sinceIso).map((r) => r.notionPageId),
    );

    if (dryRun) {
      logger.info("fix_hour_shift_dry_run", { since: sinceIso, affected_rows: affectedPageIds.size });
      return 0;
    }

    if (affectedPageIds.size === 0) {
      logger.info("fix_hour_shift_nothing_to_do", {});
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

    const n2gConfig = {
      defaultEventDurationMin: cfg.sync.defaultEventDurationMin,
      timezone: cfg.sync.timezone,
      eventColorId: cfg.sync.eventColorId,
    };

    // --- preview mode ---
    if (preview) {
      console.log(`\n${"─".repeat(110)}`);
      console.log(
        `${"Titre".padEnd(50)} ${"Google AVANT".padEnd(20)} ${"Notion→Google APRÈS".padEnd(20)} ${"Action"}`,
      );
      console.log(`${"─".repeat(110)}`);

      for (const task of toFix) {
        if (task.isAllDay) continue;
        const row = getSyncedTaskByPageId(db, task.pageId);
        if (!row) continue;

        const body = buildEventBodyFromTask(task, n2gConfig);
        const afterUtc = body.start.dateTime ?? task.dateStart;
        const afterStr = toParisLocal(afterUtc);

        let beforeStr = "?";
        let googleUtc = "";
        try {
          const current = await calendar.getEvent(row.googleCalendarId, row.googleEventId);
          if (current?.start.dateTime) {
            googleUtc = new Date(current.start.dateTime).toISOString();
            beforeStr = toParisLocal(googleUtc);
          }
        } catch { /* ignore */ }

        const same = googleUtc && sameTime(googleUtc, afterUtc);
        const action = same ? "+2h Notion+Google" : "sync Notion→Google";

        const title = (task.title ?? "").slice(0, 48).padEnd(50);
        console.log(`${title} ${beforeStr.padEnd(20)} ${afterStr.padEnd(20)} ${action}`);
      }
      console.log(`${"─".repeat(110)}\n`);
      return 0;
    }

    // --- fix modes ---
    logger.info("fix_hour_shift_start", {
      mode: fixAll ? "fix-all" : "notion-to-google-only",
      since: sinceIso,
      to_fix: toFix.length,
    });

    const stats: SyncN2GStats = {
      seen: 0, created: 0, updated: 0, moved: 0, deleted: 0,
      skipped: 0, errors: 0, errorMessages: [],
    };
    const n2gParams = { db, calendar, config: n2gConfig };

    let notionFixed = 0;

    for (const task of toFix) {
      stats.seen++;
      try {
        if (fixAll && !task.isAllDay) {
          // Check if Notion and Google are stuck at the same wrong time.
          const row = getSyncedTaskByPageId(db, task.pageId);
          if (row) {
            const current = await calendar.getEvent(row.googleCalendarId, row.googleEventId);
            const googleUtc = current?.start.dateTime
              ? new Date(current.start.dateTime).toISOString()
              : null;
            const notionUtc = task.dateStart;

            if (googleUtc && sameTime(googleUtc, notionUtc)) {
              // Case (b): both wrong — fix Notion +2h first.
              const correctedStart = shiftIsoByTwoHours(task.dateStart);
              const correctedEnd = task.dateEnd ? shiftIsoByTwoHours(task.dateEnd) : null;

              await notion.updateTaskPage({
                pageId: task.pageId,
                title: task.title,
                dateStart: correctedStart,
                dateEnd: correctedEnd,
                isAllDay: false,
                timezone: cfg.sync.timezone,
              });
              notionFixed++;
              logger.info("fix_notion_shifted", {
                title: task.title,
                from: toParisLocal(notionUtc),
                to: toParisLocal(correctedStart),
              });

              // Build corrected task for Google push.
              const correctedTask: NotionTask = {
                ...task,
                dateStart: correctedStart,
                dateEnd: correctedEnd,
              };
              await syncTaskN2G(correctedTask, n2gParams, stats);
              continue;
            }
          }
        }

        // Case (a): Notion correct, just re-sync to Google.
        await syncTaskN2G(task, n2gParams, stats);
        logger.info("fix_google_synced", {
          title: task.title,
          time_paris: toParisLocal(task.dateStart),
        });
      } catch (err) {
        stats.errors++;
        logger.error("fix_error", { title: task.title, error: (err as Error).message });
      }
    }

    logger.info("fix_done", {
      seen: stats.seen,
      notion_corrected: notionFixed,
      google_updated: stats.updated,
      skipped: stats.skipped,
      errors: stats.errors,
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
