import type { CalendarClient } from "./calendar.ts";
import type { NotionService } from "./notion.ts";
import {
  type Database,
  finishSyncRun,
  getLastSuccessfulRun,
  getMeta,
  setMeta,
  startSyncRun,
  type SyncRunStats,
} from "./db.ts";
import { logger } from "./logger.ts";
import { runSyncN2G, type SyncN2GConfig, type SyncN2GStats } from "./sync-n2g.ts";
import { runSyncG2N, type SyncG2NConfig, type SyncG2NStats } from "./sync-g2n.ts";
import { type ReconcileConfig, runReconcile } from "./sync-reconcile.ts";

const FAILURE_THRESHOLD = 0.5;
const MAX_ERROR_DETAIL = 5;

export interface IncrementalConfig {
  n2g: SyncN2GConfig;
  g2n: SyncG2NConfig;
  lookbackMin: number;
  reconcileIntervalHours: number;
}

export interface ReconcileCallbackParams {
  db: Database;
  notion: NotionService;
  calendar: CalendarClient;
  now?: () => Date;
}

export type ReconcileCallback = (
  params: ReconcileCallbackParams,
) => Promise<SyncRunStats>;

export interface IncrementalParams {
  db: Database;
  notion: NotionService;
  calendar: CalendarClient;
  config: IncrementalConfig;
  now?: () => Date;
  reconcile?: ReconcileCallback;
}

export interface IncrementalResult {
  runId: number;
  status: "success" | "failed";
  stats: SyncRunStats;
  errorDetail: string | null;
  reconcileTriggered: boolean;
}

export function computeSinceIso(
  lastStartedAt: string | null,
  lookbackMin: number,
  now: Date,
): string {
  const base = lastStartedAt ? new Date(lastStartedAt) : now;
  return new Date(base.getTime() - lookbackMin * 60_000).toISOString();
}

export function shouldReconcile(
  lastReconcileIso: string | null,
  intervalHours: number,
  now: Date,
): boolean {
  if (!lastReconcileIso) return true;
  const elapsedMs = now.getTime() - new Date(lastReconcileIso).getTime();
  return elapsedMs >= intervalHours * 3_600_000;
}

export async function runIncremental(
  params: IncrementalParams,
): Promise<IncrementalResult> {
  const { db } = params;
  const nowFn = params.now ?? (() => new Date());
  const now = nowFn();
  const wallStart = Date.now();

  const runId = startSyncRun(db, "incremental");
  logger.info("run_start", { mode: "incremental", run_id: runId });

  const lastSuccess = getLastSuccessfulRun(db, "incremental");
  const sinceIso = computeSinceIso(
    lastSuccess?.startedAt ?? null,
    params.config.lookbackMin,
    now,
  );

  // Pass 1 — Notion → Google (source canonical for task content).
  const n2g = await runSyncN2G({
    db: params.db,
    notion: params.notion,
    calendar: params.calendar,
    config: params.config.n2g,
    sinceIso,
    now: nowFn,
  });

  // Pass 2 — Google → Notion (ingestion + linked updates).
  const g2n = await runSyncG2N({
    db: params.db,
    notion: params.notion,
    calendar: params.calendar,
    config: params.config.g2n,
    now: nowFn,
  });

  // Reconcile dispatch (if due). The reconcile body lives in sync.ts via an
  // injected callback — step 10 plugs in the real implementation.
  const reconcileOutcome = await maybeRunReconcile(params, now);

  const mergedStats = aggregateStats(n2g, g2n, reconcileOutcome.stats);
  const status = exceedsFailureThreshold(n2g) || exceedsFailureThreshold(g2n)
    ? "failed"
    : "success";
  const errorDetail = buildErrorDetail(n2g, g2n, reconcileOutcome.errorMessage);

  finishSyncRun(db, runId, mergedStats, status, errorDetail);

  logger.info("run_end", {
    mode: "incremental",
    run_id: runId,
    status,
    duration_ms: Date.now() - wallStart,
    n2g_seen: n2g.seen,
    n2g_created: n2g.created,
    n2g_updated: n2g.updated,
    n2g_moved: n2g.moved,
    n2g_deleted: n2g.deleted,
    n2g_skipped: n2g.skipped,
    g2n_seen: g2n.seen,
    g2n_created: g2n.created,
    g2n_updated: g2n.updated,
    g2n_deleted: g2n.deleted,
    g2n_skipped: g2n.skipped,
    errors: mergedStats.errors,
  });

  return {
    runId,
    status,
    stats: mergedStats,
    errorDetail,
    reconcileTriggered: reconcileOutcome.triggered,
  };
}

interface ReconcileOutcome {
  triggered: boolean;
  stats: SyncRunStats | null;
  errorMessage: string | null;
}

async function maybeRunReconcile(
  params: IncrementalParams,
  now: Date,
): Promise<ReconcileOutcome> {
  const lastReconcile = getMeta(params.db, "last_reconcile");
  if (!shouldReconcile(lastReconcile, params.config.reconcileIntervalHours, now)) {
    return { triggered: false, stats: null, errorMessage: null };
  }
  if (!params.reconcile) {
    // Step 10 wires the real implementation; until then we log the dispatch
    // intent without silently missing it.
    logger.debug("reconcile_not_wired", {
      reason: lastReconcile ? "interval_due" : "first_run",
    });
    return { triggered: true, stats: null, errorMessage: null };
  }
  logger.info("reconcile_trigger", {
    reason: lastReconcile ? "interval_due" : "first_run",
  });
  try {
    const stats = await params.reconcile({
      db: params.db,
      notion: params.notion,
      calendar: params.calendar,
      now: params.now,
    });
    setMeta(params.db, "last_reconcile", now.toISOString());
    return { triggered: true, stats, errorMessage: null };
  } catch (err) {
    const message = (err as Error).message;
    logger.error("reconcile_failed", { error: message });
    return { triggered: true, stats: null, errorMessage: `reconcile: ${message}` };
  }
}

function aggregateStats(
  n2g: SyncN2GStats,
  g2n: SyncG2NStats,
  reconcile: SyncRunStats | null,
): SyncRunStats {
  const base: SyncRunStats = {
    n2gSeen: n2g.seen,
    n2gCreated: n2g.created,
    n2gUpdated: n2g.updated,
    n2gMoved: n2g.moved,
    n2gDeleted: n2g.deleted,
    n2gSkipped: n2g.skipped,
    g2nSeen: g2n.seen,
    g2nCreated: g2n.created,
    g2nUpdated: g2n.updated,
    g2nDeleted: g2n.deleted,
    g2nSkipped: g2n.skipped,
    errors: n2g.errors + g2n.errors,
  };
  if (!reconcile) return base;
  return {
    n2gSeen: base.n2gSeen + reconcile.n2gSeen,
    n2gCreated: base.n2gCreated + reconcile.n2gCreated,
    n2gUpdated: base.n2gUpdated + reconcile.n2gUpdated,
    n2gMoved: base.n2gMoved + reconcile.n2gMoved,
    n2gDeleted: base.n2gDeleted + reconcile.n2gDeleted,
    n2gSkipped: base.n2gSkipped + reconcile.n2gSkipped,
    g2nSeen: base.g2nSeen + reconcile.g2nSeen,
    g2nCreated: base.g2nCreated + reconcile.g2nCreated,
    g2nUpdated: base.g2nUpdated + reconcile.g2nUpdated,
    g2nDeleted: base.g2nDeleted + reconcile.g2nDeleted,
    g2nSkipped: base.g2nSkipped + reconcile.g2nSkipped,
    errors: base.errors + reconcile.errors,
  };
}

function exceedsFailureThreshold(stats: { seen: number; errors: number }): boolean {
  if (stats.seen === 0) return false;
  return stats.errors / stats.seen > FAILURE_THRESHOLD;
}

function buildErrorDetail(
  n2g: SyncN2GStats,
  g2n: SyncG2NStats,
  reconcileMessage: string | null,
): string | null {
  const all: string[] = [];
  for (const m of n2g.errorMessages) all.push(`[n2g] ${m}`);
  for (const m of g2n.errorMessages) all.push(`[g2n] ${m}`);
  if (reconcileMessage) all.push(`[reconcile] ${reconcileMessage}`);
  if (all.length === 0) return null;
  return all.slice(0, MAX_ERROR_DETAIL).join("\n");
}

// -- Standalone reconcile mode (`main.ts reconcile`) -----------------------

export interface ReconcileModeParams {
  db: Database;
  notion: NotionService;
  calendar: CalendarClient;
  config: ReconcileConfig;
  now?: () => Date;
}

export interface ReconcileModeResult {
  runId: number;
  status: "success" | "failed";
  stats: SyncRunStats;
  errorDetail: string | null;
}

export async function runReconcileMode(
  params: ReconcileModeParams,
): Promise<ReconcileModeResult> {
  const { db } = params;
  const nowFn = params.now ?? (() => new Date());
  const now = nowFn();
  const wallStart = Date.now();

  const runId = startSyncRun(db, "reconcile");
  logger.info("run_start", { mode: "reconcile", run_id: runId });

  let stats: SyncRunStats;
  let errorDetail: string | null = null;
  let status: "success" | "failed";

  try {
    const result = await runReconcile(params);
    stats = result.stats;
    if (result.errorMessages.length > 0) {
      errorDetail = result.errorMessages
        .slice(0, MAX_ERROR_DETAIL)
        .map((m) => `[reconcile] ${m}`)
        .join("\n");
    }
    // Inner errors are counted but do not fail the run — reconcile is a
    // best-effort catch-up pass.
    status = "success";
    setMeta(db, "last_reconcile", now.toISOString());
  } catch (err) {
    const message = (err as Error).message;
    stats = {
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
      errors: 1,
    };
    errorDetail = `[reconcile] ${message}`;
    status = "failed";
    logger.error("reconcile_fatal", { error: message });
  }

  finishSyncRun(db, runId, stats, status, errorDetail);
  logger.info("run_end", {
    mode: "reconcile",
    run_id: runId,
    status,
    duration_ms: Date.now() - wallStart,
    n2g_deleted: stats.n2gDeleted,
    n2g_created: stats.n2gCreated,
    n2g_updated: stats.n2gUpdated,
    n2g_moved: stats.n2gMoved,
    g2n_created: stats.g2nCreated,
    g2n_deleted: stats.g2nDeleted,
    errors: stats.errors,
  });

  return { runId, status, stats, errorDetail };
}
