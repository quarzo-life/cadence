import { Client as NotionClient } from "@notionhq/client";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createGoogleAuth } from "./google-auth.ts";
import { createCalendarClient } from "./calendar.ts";
import { createNotionService } from "./notion.ts";
import { runIncremental, runReconcileMode } from "./sync.ts";
import { runReconcile } from "./sync-reconcile.ts";
import { logger } from "./logger.ts";

export type Mode = "incremental" | "reconcile";

export function parseMode(args: string[]): Mode | null {
  if (args.length === 0) return "incremental";
  const m = args[0].toLowerCase();
  if (m === "incremental" || m === "reconcile") return m;
  return null;
}

async function main(): Promise<number> {
  const mode = parseMode(Deno.args);
  if (mode === null) {
    console.error(
      `unknown mode: "${Deno.args[0]}" (expected "incremental" or "reconcile")`,
    );
    return 1;
  }

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
    console.error(`database init failed at ${cfg.database.path}: ${(err as Error).message}`);
    return 1;
  }

  try {
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

    const reconcileConfig = {
      n2g: {
        defaultEventDurationMin: cfg.sync.defaultEventDurationMin,
        timezone: cfg.sync.timezone,
        eventColorId: cfg.sync.eventColorId,
      },
      timezone: cfg.sync.timezone,
    };

    if (mode === "reconcile") {
      const result = await runReconcileMode({
        db,
        notion,
        calendar,
        config: reconcileConfig,
      });
      return result.status === "success" ? 0 : 1;
    }

    const result = await runIncremental({
      db,
      notion,
      calendar,
      config: {
        n2g: reconcileConfig.n2g,
        g2n: {
          watchEmails: cfg.google.watchEmails,
          syncKeyword: cfg.google.syncKeyword,
          timezone: cfg.sync.timezone,
        },
        lookbackMin: cfg.sync.lookbackMin,
        reconcileIntervalHours: cfg.sync.reconcileIntervalHours,
      },
      reconcile: async (p) => {
        const r = await runReconcile({ ...p, config: reconcileConfig });
        return r.stats;
      },
    });

    return result.status === "success" ? 0 : 1;
  } catch (err) {
    logger.error("run_fatal", {
      error: (err as Error).message,
      stack: (err as Error).stack ?? "",
    });
    return 1;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}
