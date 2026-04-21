import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import {
  createEmptyStats,
  deleteSyncedTaskByPageId,
  deleteSyncToken,
  finishSyncRun,
  getLastSuccessfulRun,
  getMeta,
  getSyncedTaskByEventId,
  getSyncedTaskByPageId,
  getSyncToken,
  listSyncedTasks,
  openDatabase,
  setMeta,
  startSyncRun,
  type SyncedTask,
  upsertSyncedTask,
  upsertSyncToken,
} from "../db.ts";

function makeTask(overrides: Partial<SyncedTask> = {}): SyncedTask {
  return {
    notionPageId: "page-1",
    googleEventId: "evt-1",
    googleCalendarId: "alice@co.com",
    source: "notion",
    notionLastEditedAt: "2026-04-21T09:00:00.000Z",
    googleUpdatedAt: null,
    lastSyncedAt: "2026-04-21T09:00:01.000Z",
    title: "Call client",
    ...overrides,
  };
}

Deno.test("openDatabase — applies migrations and is idempotent", () => {
  const db = openDatabase(":memory:");
  try {
    // Re-opening the same migrations on the same DB handle must not throw.
    db.exec(Deno.readTextFileSync(new URL("../migrations.sql", import.meta.url)));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all<{ name: string }>()
      .map((r) => r.name);
    assert(tables.includes("synced_tasks"));
    assert(tables.includes("google_sync_tokens"));
    assert(tables.includes("sync_runs"));
    assert(tables.includes("meta"));
  } finally {
    db.close();
  }
});

Deno.test("synced_tasks — upsert, get by page id, get by event id", () => {
  const db = openDatabase(":memory:");
  try {
    assertEquals(getSyncedTaskByPageId(db, "page-1"), null);
    const task = makeTask();
    upsertSyncedTask(db, task);
    assertEquals(getSyncedTaskByPageId(db, "page-1"), task);
    assertEquals(getSyncedTaskByEventId(db, "evt-1"), task);
    assertEquals(getSyncedTaskByEventId(db, "ghost"), null);
  } finally {
    db.close();
  }
});

Deno.test("synced_tasks — upsert updates on conflict", () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeTask());
    upsertSyncedTask(
      db,
      makeTask({
        googleEventId: "evt-2",
        googleCalendarId: "bob@co.com",
        title: "Moved to Bob",
        googleUpdatedAt: "2026-04-21T10:00:00.000Z",
      }),
    );
    const got = getSyncedTaskByPageId(db, "page-1");
    assertEquals(got?.googleEventId, "evt-2");
    assertEquals(got?.googleCalendarId, "bob@co.com");
    assertEquals(got?.title, "Moved to Bob");
    assertEquals(got?.googleUpdatedAt, "2026-04-21T10:00:00.000Z");
    // Old event id must no longer resolve.
    assertEquals(getSyncedTaskByEventId(db, "evt-1"), null);
  } finally {
    db.close();
  }
});

Deno.test("synced_tasks — list and delete", () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeTask({ notionPageId: "p1", googleEventId: "e1" }));
    upsertSyncedTask(db, makeTask({ notionPageId: "p2", googleEventId: "e2" }));
    assertEquals(listSyncedTasks(db).length, 2);
    deleteSyncedTaskByPageId(db, "p1");
    const rest = listSyncedTasks(db);
    assertEquals(rest.length, 1);
    assertEquals(rest[0].notionPageId, "p2");
  } finally {
    db.close();
  }
});

Deno.test("google_sync_tokens — upsert, get, delete", () => {
  const db = openDatabase(":memory:");
  try {
    assertEquals(getSyncToken(db, "alice@co.com"), null);
    upsertSyncToken(db, "alice@co.com", "token-1");
    assertEquals(getSyncToken(db, "alice@co.com"), "token-1");
    upsertSyncToken(db, "alice@co.com", "token-2");
    assertEquals(getSyncToken(db, "alice@co.com"), "token-2");
    deleteSyncToken(db, "alice@co.com");
    assertEquals(getSyncToken(db, "alice@co.com"), null);
  } finally {
    db.close();
  }
});

Deno.test("sync_runs — start, finish, get last successful by mode", () => {
  const db = openDatabase(":memory:");
  try {
    assertEquals(getLastSuccessfulRun(db, "incremental"), null);

    const id1 = startSyncRun(db, "incremental");
    const stats = createEmptyStats();
    stats.n2gCreated = 2;
    stats.g2nSkipped = 4;
    finishSyncRun(db, id1, stats, "success");

    const id2 = startSyncRun(db, "incremental");
    finishSyncRun(db, id2, createEmptyStats(), "failed", "boom");

    const id3 = startSyncRun(db, "reconcile");
    finishSyncRun(db, id3, createEmptyStats(), "success");

    const lastIncremental = getLastSuccessfulRun(db, "incremental");
    assertEquals(lastIncremental?.id, id1);
    assertEquals(lastIncremental?.stats.n2gCreated, 2);
    assertEquals(lastIncremental?.stats.g2nSkipped, 4);
    assertEquals(lastIncremental?.status, "success");
    assertNotEquals(lastIncremental?.endedAt, null);

    const lastReconcile = getLastSuccessfulRun(db, "reconcile");
    assertEquals(lastReconcile?.id, id3);
  } finally {
    db.close();
  }
});

Deno.test("meta — set and get, overwrite on conflict", () => {
  const db = openDatabase(":memory:");
  try {
    assertEquals(getMeta(db, "last_reconcile"), null);
    setMeta(db, "last_reconcile", "2026-04-21T09:00:00.000Z");
    assertEquals(getMeta(db, "last_reconcile"), "2026-04-21T09:00:00.000Z");
    setMeta(db, "last_reconcile", "2026-04-21T10:00:00.000Z");
    assertEquals(getMeta(db, "last_reconcile"), "2026-04-21T10:00:00.000Z");
  } finally {
    db.close();
  }
});
