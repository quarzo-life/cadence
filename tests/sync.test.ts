import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  createEmptyStats,
  type Database,
  finishSyncRun,
  getLastSuccessfulRun,
  getMeta,
  getSyncedTaskByEventId,
  openDatabase,
  setMeta,
  startSyncRun,
  type SyncRunStats,
  upsertSyncedTask,
} from "../db.ts";
import type { CalendarClient, CalendarEvent } from "../calendar.ts";
import type {
  CreateTaskArgs,
  NotionService,
  NotionTask,
  NotionUser,
} from "../notion.ts";
import {
  computeSinceIso,
  type IncrementalConfig,
  runIncremental,
  shouldReconcile,
} from "../sync.ts";

const NOW = new Date("2026-04-21T12:00:00.000Z");

function baseConfig(overrides: Partial<IncrementalConfig> = {}): IncrementalConfig {
  return {
    n2g: { defaultEventDurationMin: 30, timezone: "Europe/Paris" },
    g2n: { watchEmails: [], syncKeyword: "NOTION", timezone: "Europe/Paris" },
    lookbackMin: 15,
    reconcileIntervalHours: 24,
    ...overrides,
  };
}

function stubNotion(overrides: Partial<NotionService> = {}): NotionService {
  return {
    queryTasksSince: () => Promise.resolve([]),
    queryAllTasks: () => Promise.resolve([]),
    createTaskPage: () =>
      Promise.resolve({ pageId: "p", lastEditedAt: "2026-04-21T12:00:00.000Z" }),
    updateTaskPage: () =>
      Promise.resolve({ lastEditedAt: "2026-04-21T12:00:00.000Z" }),
    archiveTaskPage: () => Promise.resolve(),
    listUsers: () => Promise.resolve([]),
    ...overrides,
  };
}

function stubCalendar(overrides: Partial<CalendarClient> = {}): CalendarClient {
  return {
    createEvent: () =>
      Promise.resolve({
        id: "evt",
        status: "confirmed",
        summary: "x",
        start: { date: "2026-04-21" },
        end: { date: "2026-04-22" },
        updated: "2026-04-21T12:00:00.000Z",
      } as CalendarEvent),
    patchEvent: () =>
      Promise.resolve({
        id: "evt",
        status: "confirmed",
        summary: "x",
        start: { date: "2026-04-21" },
        end: { date: "2026-04-22" },
        updated: "2026-04-21T12:00:00.000Z",
      } as CalendarEvent),
    deleteEvent: () => Promise.resolve(),
    getEvent: () => Promise.resolve(null),
    findByNotionPageId: () => Promise.resolve(null),
    listPage: () =>
      Promise.resolve({ events: [], nextPageToken: null, nextSyncToken: null }),
    listAll: () => Promise.resolve({ events: [], nextSyncToken: null }),
    ...overrides,
  };
}

// -- computeSinceIso --------------------------------------------------------

Deno.test("computeSinceIso — no previous run uses now - lookback", () => {
  assertEquals(
    computeSinceIso(null, 15, new Date("2026-04-21T12:00:00.000Z")),
    "2026-04-21T11:45:00.000Z",
  );
});

Deno.test("computeSinceIso — subtracts lookback from lastStartedAt", () => {
  assertEquals(
    computeSinceIso(
      "2026-04-21T11:55:00.000Z",
      15,
      new Date("2026-04-21T12:00:00.000Z"),
    ),
    "2026-04-21T11:40:00.000Z",
  );
});

// -- shouldReconcile --------------------------------------------------------

Deno.test("shouldReconcile — null meta triggers reconcile", () => {
  assertEquals(shouldReconcile(null, 24, NOW), true);
});

Deno.test("shouldReconcile — older than interval → true", () => {
  assertEquals(
    shouldReconcile("2026-04-20T10:00:00.000Z", 24, NOW), // 26h elapsed
    true,
  );
});

Deno.test("shouldReconcile — fresher than interval → false", () => {
  assertEquals(
    shouldReconcile("2026-04-21T01:00:00.000Z", 24, NOW), // 11h elapsed
    false,
  );
});

Deno.test("shouldReconcile — exactly at interval boundary → true", () => {
  assertEquals(
    shouldReconcile("2026-04-20T12:00:00.000Z", 24, NOW),
    true,
  );
});

// -- runIncremental — bookkeeping -------------------------------------------

Deno.test("runIncremental — happy path with empty passes writes success row", async () => {
  const db = openDatabase(":memory:");
  try {
    const result = await runIncremental({
      db,
      notion: stubNotion(),
      calendar: stubCalendar(),
      config: baseConfig(),
      now: () => NOW,
    });
    assertEquals(result.status, "success");
    assertEquals(result.stats.errors, 0);
    assertEquals(result.errorDetail, null);
    const saved = getLastSuccessfulRun(db, "incremental");
    assert(saved);
    assertEquals(saved!.id, result.runId);
    assertEquals(saved!.stats.n2gSeen, 0);
    assertEquals(saved!.stats.g2nSeen, 0);
  } finally {
    db.close();
  }
});

Deno.test("runIncremental — computes sinceIso from previous successful run", async () => {
  const db = openDatabase(":memory:");
  try {
    // Seed a prior successful run.
    const priorId = startSyncRun(db, "incremental");
    finishSyncRun(db, priorId, createEmptyStats(), "success");
    // Freeze start time of that row to a known value.
    db.prepare("UPDATE sync_runs SET started_at = ? WHERE id = ?").run(
      "2026-04-21T11:55:00.000Z",
      priorId,
    );

    let receivedSince: string | null = null;
    const notion = stubNotion({
      queryTasksSince: (since) => {
        receivedSince = since;
        return Promise.resolve([]);
      },
    });
    await runIncremental({
      db,
      notion,
      calendar: stubCalendar(),
      config: baseConfig({ lookbackMin: 15 }),
      now: () => NOW,
    });
    assertEquals(receivedSince, "2026-04-21T11:40:00.000Z");
  } finally {
    db.close();
  }
});

Deno.test("runIncremental — aggregates stats from both passes into the run row", async () => {
  const db = openDatabase(":memory:");
  try {
    const task: NotionTask = {
      pageId: "p-1",
      title: "X",
      dateStart: "2026-04-22",
      dateEnd: null,
      isAllDay: true,
      ownerEmail: "alice@co.com",
      ownerName: "Alice",
      statusValue: null,
      lastEditedAt: "2026-04-21T11:59:00.000Z",
      url: "https://www.notion.so/p-1",
      isArchived: false,
    };
    const users: NotionUser[] = [
      { id: "user-alice", name: "Alice", email: "alice@co.com" },
    ];
    const notion = stubNotion({
      queryTasksSince: () => Promise.resolve([task]),
      listUsers: () => Promise.resolve(users),
    });
    const calendar = stubCalendar({
      listAll: () =>
        Promise.resolve({
          events: [
            {
              id: "evt-1",
              status: "confirmed",
              summary: "NOTION: Q3",
              start: { date: "2026-04-24" },
              end: { date: "2026-04-25" },
              updated: "2026-04-21T09:00:00.000Z",
            } as CalendarEvent,
          ],
          nextSyncToken: "tok-2",
        }),
    });
    const result = await runIncremental({
      db,
      notion,
      calendar,
      config: baseConfig({
        g2n: {
          watchEmails: ["alice@co.com"],
          syncKeyword: "NOTION",
          timezone: "Europe/Paris",
        },
      }),
      now: () => NOW,
    });
    assertEquals(result.stats.n2gSeen, 1);
    assertEquals(result.stats.n2gCreated, 1);
    assertEquals(result.stats.g2nSeen, 1);
    assertEquals(result.stats.g2nCreated, 1);
    assertEquals(result.status, "success");
    const saved = getLastSuccessfulRun(db, "incremental");
    assertEquals(saved!.stats.n2gCreated, 1);
    assertEquals(saved!.stats.g2nCreated, 1);
  } finally {
    db.close();
  }
});

Deno.test("runIncremental — >50% n2g errors → run marked failed, errors captured in detail", async () => {
  const db = openDatabase(":memory:");
  try {
    const tasks: NotionTask[] = Array.from({ length: 4 }, (_, i) => ({
      pageId: `p-${i}`,
      title: `T${i}`,
      dateStart: "2026-04-22",
      dateEnd: null,
      isAllDay: true,
      ownerEmail: "alice@co.com",
      ownerName: "Alice",
      statusValue: null,
      lastEditedAt: "2026-04-21T11:59:00.000Z",
      url: `https://www.notion.so/p-${i}`,
      isArchived: false,
    }));
    const notion = stubNotion({
      queryTasksSince: () => Promise.resolve(tasks),
    });
    const calendar = stubCalendar({
      findByNotionPageId: () => Promise.resolve(null),
      createEvent: () => Promise.reject(new Error("google-down")),
    });
    const result = await runIncremental({
      db,
      notion,
      calendar,
      config: baseConfig(),
      now: () => NOW,
    });
    assertEquals(result.status, "failed");
    assert(result.errorDetail !== null);
    assert(result.errorDetail!.includes("[n2g]"));
    assert(result.errorDetail!.includes("google-down"));
    // Run row must reflect failed status.
    const row = db
      .prepare("SELECT status, error_detail FROM sync_runs WHERE id = ?")
      .get<{ status: string; error_detail: string | null }>(result.runId);
    assertEquals(row?.status, "failed");
    assert(row?.error_detail?.includes("google-down"));
  } finally {
    db.close();
  }
});

// -- Reconcile dispatch -----------------------------------------------------

Deno.test("runIncremental — first run triggers reconcile callback and updates meta", async () => {
  const db = openDatabase(":memory:");
  try {
    let reconcileCalled = false;
    const reconcile = () => {
      reconcileCalled = true;
      const s = createEmptyStats();
      s.n2gDeleted = 3;
      return Promise.resolve(s);
    };
    const result = await runIncremental({
      db,
      notion: stubNotion(),
      calendar: stubCalendar(),
      config: baseConfig(),
      now: () => NOW,
      reconcile,
    });
    assertEquals(reconcileCalled, true);
    assertEquals(result.reconcileTriggered, true);
    assertEquals(getMeta(db, "last_reconcile"), NOW.toISOString());
    // Reconcile stats merged into run row.
    assertEquals(result.stats.n2gDeleted, 3);
  } finally {
    db.close();
  }
});

Deno.test("runIncremental — recent reconcile meta → callback not invoked", async () => {
  const db = openDatabase(":memory:");
  try {
    setMeta(db, "last_reconcile", "2026-04-21T01:00:00.000Z"); // 11h ago
    let reconcileCalled = false;
    await runIncremental({
      db,
      notion: stubNotion(),
      calendar: stubCalendar(),
      config: baseConfig({ reconcileIntervalHours: 24 }),
      now: () => NOW,
      reconcile: () => {
        reconcileCalled = true;
        return Promise.resolve(createEmptyStats());
      },
    });
    assertEquals(reconcileCalled, false);
    assertEquals(getMeta(db, "last_reconcile"), "2026-04-21T01:00:00.000Z");
  } finally {
    db.close();
  }
});

Deno.test("runIncremental — no callback provided but due → triggered flag true, meta untouched", async () => {
  const db = openDatabase(":memory:");
  try {
    const result = await runIncremental({
      db,
      notion: stubNotion(),
      calendar: stubCalendar(),
      config: baseConfig(),
      now: () => NOW,
    });
    assertEquals(result.reconcileTriggered, true);
    assertEquals(getMeta(db, "last_reconcile"), null);
  } finally {
    db.close();
  }
});

Deno.test("runIncremental — reconcile callback throws → logged, run still success, meta not updated", async () => {
  const db = openDatabase(":memory:");
  try {
    const result = await runIncremental({
      db,
      notion: stubNotion(),
      calendar: stubCalendar(),
      config: baseConfig(),
      now: () => NOW,
      reconcile: () => Promise.reject(new Error("reconcile-broke")),
    });
    assertEquals(result.status, "success");
    assert(result.errorDetail?.includes("[reconcile]"));
    assert(result.errorDetail?.includes("reconcile-broke"));
    assertEquals(getMeta(db, "last_reconcile"), null);
  } finally {
    db.close();
  }
});
