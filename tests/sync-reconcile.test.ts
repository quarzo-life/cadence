import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type Database,
  getSyncedTaskByEventId,
  getSyncedTaskByPageId,
  listSyncedTasks,
  openDatabase,
  type SyncedTask,
  upsertSyncedTask,
} from "../db.ts";
import type { CalendarClient, CalendarEvent } from "../calendar.ts";
import type {
  CreateTaskArgs,
  NotionService,
  NotionTask,
  NotionUser,
} from "../notion.ts";
import { type ReconcileConfig, runReconcile } from "../sync-reconcile.ts";

const CFG: ReconcileConfig = {
  n2g: { defaultEventDurationMin: 30, timezone: "Europe/Paris" },
  timezone: "Europe/Paris",
};
const NOW = new Date("2026-04-21T12:00:00.000Z");

function taskFixture(overrides: Partial<NotionTask> = {}): NotionTask {
  return {
    pageId: "page-1",
    title: "Call client",
    dateStart: "2026-04-22T10:00:00.000Z",
    dateEnd: null,
    isAllDay: false,
    ownerEmail: "alice@co.com",
    ownerName: "Alice",
    statusValue: null,
    lastEditedAt: "2026-04-21T09:00:00.000Z",
    url: "https://www.notion.so/page-1",
    isArchived: false,
    ...overrides,
  };
}

function makeRow(overrides: Partial<SyncedTask> = {}): SyncedTask {
  return {
    notionPageId: "page-orphan",
    googleEventId: "evt-orphan",
    googleCalendarId: "alice@co.com",
    source: "notion",
    notionLastEditedAt: "2026-04-21T08:00:00.000Z",
    googleUpdatedAt: "2026-04-21T08:00:00.000Z",
    lastSyncedAt: "2026-04-21T08:00:00.000Z",
    title: "Orphan title",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-orphan",
    status: "confirmed",
    summary: "Recovered title",
    start: { dateTime: "2026-04-22T10:00:00.000Z", timeZone: "Europe/Paris" },
    end: { dateTime: "2026-04-22T11:00:00.000Z", timeZone: "Europe/Paris" },
    updated: "2026-04-21T09:30:00.000Z",
    ...overrides,
  };
}

interface FakeCalendar extends CalendarClient {
  deletedEvents: Array<{ email: string; eventId: string }>;
  patchedEvents: Array<{ email: string; eventId: string; body: unknown }>;
  createdEvents: Array<{ email: string; body: unknown }>;
}

function fakeCalendar(opts: {
  getEvent?: (email: string, eventId: string) => CalendarEvent | null;
  throwOnDelete?: (eventId: string) => Error | null;
} = {}): FakeCalendar {
  const deletedEvents: Array<{ email: string; eventId: string }> = [];
  const patchedEvents: Array<{ email: string; eventId: string; body: unknown }> = [];
  const createdEvents: Array<{ email: string; body: unknown }> = [];
  let nextId = 200;
  return {
    deletedEvents,
    patchedEvents,
    createdEvents,
    deleteEvent: (email, eventId) => {
      const thrown = opts.throwOnDelete?.(eventId);
      if (thrown) return Promise.reject(thrown);
      deletedEvents.push({ email, eventId });
      return Promise.resolve();
    },
    getEvent: (email, eventId) =>
      Promise.resolve(opts.getEvent?.(email, eventId) ?? null),
    patchEvent: (email, eventId, body) => {
      patchedEvents.push({ email, eventId, body });
      return Promise.resolve({
        ...makeEvent({ id: eventId, updated: "2026-04-21T09:45:00.000Z" }),
        summary: (body.summary as string | undefined) ?? "x",
        extendedProperties: body.extendedProperties,
      });
    },
    createEvent: (email, body) => {
      createdEvents.push({ email, body });
      return Promise.resolve(
        makeEvent({ id: `evt-${nextId++}`, summary: body.summary, updated: "2026-04-21T10:00:00.000Z" }),
      );
    },
    findByNotionPageId: () => Promise.resolve(null),
    listPage: () => {
      throw new Error("listPage not used in reconcile");
    },
    listAll: () => {
      throw new Error("listAll not used in reconcile");
    },
  };
}

interface FakeNotion extends NotionService {
  created: CreateTaskArgs[];
  archived: string[];
}

function fakeNotion(opts: {
  tasks: NotionTask[];
  users?: NotionUser[];
  onCreate?: (args: CreateTaskArgs) => { pageId: string; lastEditedAt: string };
}): FakeNotion {
  const created: CreateTaskArgs[] = [];
  const archived: string[] = [];
  let nextId = 300;
  return {
    created,
    archived,
    queryAllTasks: () => Promise.resolve(opts.tasks),
    queryTasksSince: () => Promise.resolve(opts.tasks),
    listUsers: () => Promise.resolve(opts.users ?? []),
    createTaskPage: (args) => {
      created.push(args);
      return Promise.resolve(
        opts.onCreate?.(args) ??
          {
            pageId: `page-new-${nextId++}`,
            lastEditedAt: "2026-04-21T12:00:00.000Z",
          },
      );
    },
    updateTaskPage: () =>
      Promise.resolve({ lastEditedAt: "2026-04-21T12:00:00.000Z" }),
    archiveTaskPage: (pageId) => {
      archived.push(pageId);
      return Promise.resolve();
    },
  };
}

// -- Orphan with source='notion' --------------------------------------------

Deno.test("reconcile — orphan source='notion' → delete Google event + drop row", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow({ source: "notion", notionPageId: "page-gone" }));
    const notion = fakeNotion({
      tasks: [], // hard-deleted from Notion
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const cal = fakeCalendar();
    const { stats } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.n2gDeleted, 1);
    assertEquals(cal.deletedEvents.length, 1);
    assertEquals(cal.deletedEvents[0].eventId, "evt-orphan");
    assertEquals(getSyncedTaskByPageId(db, "page-gone"), null);
  } finally {
    db.close();
  }
});

// -- Orphan with source='google' — event still live -------------------------

Deno.test("reconcile — orphan source='google' with live event → recreate page + reseal + new row", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow({ source: "google", notionPageId: "page-mirror-gone" }));
    const notion = fakeNotion({
      tasks: [],
      users: [{ id: "user-alice", name: "Alice", email: "alice@co.com" }],
      onCreate: () => ({ pageId: "page-recreated", lastEditedAt: "2026-04-21T12:00:00.000Z" }),
    });
    const cal = fakeCalendar({
      getEvent: () => makeEvent({ summary: "Recovered title" }),
    });
    const { stats } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.g2nCreated, 1);
    assertEquals(notion.created.length, 1);
    assertEquals(notion.created[0].title, "Recovered title");
    assertEquals(notion.created[0].ownerUserId, "user-alice");
    // Resealed with new notion_page_id.
    assertEquals(cal.patchedEvents.length, 1);
    const body = cal.patchedEvents[0].body as {
      extendedProperties?: { private?: { notion_page_id?: string } };
    };
    assertEquals(body.extendedProperties?.private?.notion_page_id, "page-recreated");
    // Row PK shifted.
    assertEquals(getSyncedTaskByPageId(db, "page-mirror-gone"), null);
    const fresh = getSyncedTaskByEventId(db, "evt-orphan");
    assert(fresh);
    assertEquals(fresh!.notionPageId, "page-recreated");
    assertEquals(fresh!.source, "google");
  } finally {
    db.close();
  }
});

// -- Orphan with source='google' — event cancelled or gone ------------------

Deno.test("reconcile — orphan source='google' with cancelled event → drop row only", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow({ source: "google", notionPageId: "page-mirror" }));
    const notion = fakeNotion({
      tasks: [],
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const cal = fakeCalendar({
      getEvent: () => makeEvent({ status: "cancelled" }),
    });
    const { stats } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.g2nDeleted, 1);
    assertEquals(cal.patchedEvents.length, 0);
    assertEquals(notion.created.length, 0);
    assertEquals(getSyncedTaskByPageId(db, "page-mirror"), null);
  } finally {
    db.close();
  }
});

Deno.test("reconcile — orphan source='google' with event gone (404) → drop row only", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow({ source: "google", notionPageId: "page-mirror" }));
    const notion = fakeNotion({
      tasks: [],
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const cal = fakeCalendar({ getEvent: () => null });
    const { stats } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.g2nDeleted, 1);
    assertEquals(getSyncedTaskByPageId(db, "page-mirror"), null);
  } finally {
    db.close();
  }
});

Deno.test("reconcile — orphan source='google' with no matching Notion user → drop row + warn", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow({ source: "google", notionPageId: "page-mirror" }));
    const notion = fakeNotion({
      tasks: [],
      users: [], // no user for alice@co.com
    });
    const cal = fakeCalendar({ getEvent: () => makeEvent() });
    const { stats } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.g2nDeleted, 1);
    assertEquals(notion.created.length, 0);
    assertEquals(getSyncedTaskByPageId(db, "page-mirror"), null);
  } finally {
    db.close();
  }
});

// -- Step 4: re-apply N→G on visible pages ----------------------------------

Deno.test("reconcile — visible page without row → N→G create (drift recovery)", async () => {
  const db = openDatabase(":memory:");
  try {
    const task = taskFixture({ pageId: "page-live" });
    const notion = fakeNotion({
      tasks: [task],
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const cal = fakeCalendar();
    const { stats } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.n2gCreated, 1);
    assertEquals(cal.createdEvents.length, 1);
    const row = getSyncedTaskByPageId(db, "page-live");
    assertEquals(row?.source, "notion");
  } finally {
    db.close();
  }
});

Deno.test("reconcile — visible pages and orphan in same run are both handled", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(
      db,
      makeRow({ source: "notion", notionPageId: "page-gone", googleEventId: "evt-gone" }),
    );
    const liveTask = taskFixture({ pageId: "page-live" });
    const notion = fakeNotion({
      tasks: [liveTask],
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const cal = fakeCalendar();
    const { stats } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.n2gDeleted, 1);
    assertEquals(stats.n2gCreated, 1);
    assertEquals(cal.deletedEvents.length, 1);
    assertEquals(cal.createdEvents.length, 1);
    assertEquals(listSyncedTasks(db).length, 1);
    assertEquals(getSyncedTaskByPageId(db, "page-live")?.source, "notion");
  } finally {
    db.close();
  }
});

// -- Error isolation --------------------------------------------------------

Deno.test("reconcile — error on one orphan does not block the N→G pass", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow({ source: "notion", notionPageId: "page-gone" }));
    const liveTask = taskFixture({ pageId: "page-live" });
    const notion = fakeNotion({
      tasks: [liveTask],
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const cal = fakeCalendar({
      throwOnDelete: () => new Error("delete-failure"),
    });
    const { stats, errorMessages } = await runReconcile({
      db,
      notion,
      calendar: cal,
      config: CFG,
      now: () => NOW,
    });
    assertEquals(stats.errors, 1);
    assert(errorMessages.some((m) => m.includes("delete-failure")));
    // N→G pass still ran.
    assertEquals(stats.n2gCreated, 1);
  } finally {
    db.close();
  }
});
