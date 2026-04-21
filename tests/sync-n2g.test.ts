import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type Database,
  getSyncedTaskByPageId,
  openDatabase,
  type SyncedTask,
  upsertSyncedTask,
} from "../db.ts";
import type {
  CalendarClient,
  CalendarEvent,
  EventCreateBody,
  EventPatchBody,
} from "../calendar.ts";
import type { NotionService, NotionTask } from "../notion.ts";
import { runSyncN2G, type SyncN2GConfig } from "../sync-n2g.ts";

const CFG: SyncN2GConfig = { defaultEventDurationMin: 30, timezone: "Europe/Paris" };

function task(overrides: Partial<NotionTask> = {}): NotionTask {
  return {
    pageId: "page-1",
    title: "Call client",
    dateStart: "2026-04-21T10:00:00.000Z",
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

interface CalendarCall {
  op: "create" | "patch" | "delete" | "find";
  userEmail: string;
  eventId?: string;
  body?: EventCreateBody | EventPatchBody;
  notionPageId?: string;
}

interface FakeCalendar extends CalendarClient {
  calls: CalendarCall[];
}

function fakeCalendar(overrides: Partial<{
  findByNotionPageId: (userEmail: string, pageId: string) => CalendarEvent | null;
  createEvent: (userEmail: string, body: EventCreateBody) => CalendarEvent;
  patchEvent: (userEmail: string, eventId: string, body: EventPatchBody) => CalendarEvent;
  deleteEvent: (userEmail: string, eventId: string) => void;
}> = {}): FakeCalendar {
  const calls: CalendarCall[] = [];
  let nextId = 100;
  const newEvent = (userEmail: string, body: EventCreateBody): CalendarEvent => ({
    id: `evt-${nextId++}`,
    status: "confirmed",
    summary: body.summary,
    description: body.description,
    start: body.start,
    end: body.end,
    updated: `2026-04-21T10:00:00.00${nextId}Z`,
    extendedProperties: body.extendedProperties,
  });

  return {
    calls,
    findByNotionPageId: (userEmail, pageId) => {
      calls.push({ op: "find", userEmail, notionPageId: pageId });
      return Promise.resolve(overrides.findByNotionPageId?.(userEmail, pageId) ?? null);
    },
    createEvent: (userEmail, body) => {
      calls.push({ op: "create", userEmail, body });
      return Promise.resolve(overrides.createEvent?.(userEmail, body) ?? newEvent(userEmail, body));
    },
    patchEvent: (userEmail, eventId, body) => {
      calls.push({ op: "patch", userEmail, eventId, body });
      const existing = overrides.patchEvent?.(userEmail, eventId, body);
      return Promise.resolve(
        existing ?? {
          id: eventId,
          status: "confirmed",
          summary: body.summary ?? "x",
          start: body.start ?? { date: "2026-04-21" },
          end: body.end ?? { date: "2026-04-22" },
          updated: "2026-04-21T11:00:00.000Z",
        },
      );
    },
    deleteEvent: (userEmail, eventId) => {
      calls.push({ op: "delete", userEmail, eventId });
      overrides.deleteEvent?.(userEmail, eventId);
      return Promise.resolve();
    },
    getEvent: () => {
      throw new Error("getEvent should not be called in n2g");
    },
    listPage: () => {
      throw new Error("listPage should not be called in n2g");
    },
    listAll: () => {
      throw new Error("listAll should not be called in n2g");
    },
  };
}

function fakeNotion(tasks: NotionTask[]): NotionService {
  return {
    queryTasksSince: () => Promise.resolve(tasks),
    queryAllTasks: () => Promise.resolve(tasks),
    createTaskPage: () => {
      throw new Error("not used in n2g");
    },
    updateTaskPage: () => {
      throw new Error("not used in n2g");
    },
    archiveTaskPage: () => {
      throw new Error("not used in n2g");
    },
    listUsers: () => Promise.resolve([]),
  };
}

function makeRow(overrides: Partial<SyncedTask> = {}): SyncedTask {
  return {
    notionPageId: "page-1",
    googleEventId: "evt-existing",
    googleCalendarId: "alice@co.com",
    source: "notion",
    notionLastEditedAt: "2026-04-21T08:00:00.000Z",
    googleUpdatedAt: "2026-04-21T08:00:30.000Z",
    lastSyncedAt: "2026-04-21T08:00:30.000Z",
    title: "Old title",
    ...overrides,
  };
}

async function run(
  db: Database,
  tasks: NotionTask[],
  calendar: CalendarClient,
): Promise<ReturnType<typeof runSyncN2G>> {
  return await runSyncN2G({
    db,
    notion: fakeNotion(tasks),
    calendar,
    config: CFG,
    sinceIso: "2026-04-21T00:00:00.000Z",
    now: () => new Date("2026-04-21T12:00:00.000Z"),
  });
}

Deno.test("n2g — archived task with existing row → delete event + delete row", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow());
    const cal = fakeCalendar();
    const stats = await run(db, [task({ isArchived: true })], cal);
    assertEquals(stats.deleted, 1);
    assertEquals(stats.skipped, 0);
    assertEquals(cal.calls.filter((c) => c.op === "delete").length, 1);
    assertEquals(getSyncedTaskByPageId(db, "page-1"), null);
  } finally {
    db.close();
  }
});

Deno.test("n2g — archived task without row → skipped, no delete call", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar();
    const stats = await run(db, [task({ isArchived: true })], cal);
    assertEquals(stats.skipped, 1);
    assertEquals(stats.deleted, 0);
    assertEquals(cal.calls.length, 0);
  } finally {
    db.close();
  }
});

Deno.test("n2g — task without owner with existing row → delete event + delete row", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow());
    const cal = fakeCalendar();
    const stats = await run(db, [task({ ownerEmail: null })], cal);
    assertEquals(stats.deleted, 1);
    assertEquals(getSyncedTaskByPageId(db, "page-1"), null);
    const del = cal.calls.find((c) => c.op === "delete");
    assertEquals(del?.userEmail, "alice@co.com");
    assertEquals(del?.eventId, "evt-existing");
  } finally {
    db.close();
  }
});

Deno.test("n2g — task without owner without row → skipped", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar();
    const stats = await run(db, [task({ ownerEmail: null })], cal);
    assertEquals(stats.skipped, 1);
  } finally {
    db.close();
  }
});

Deno.test("n2g — fresh task (no row, no preexisting event) → create + insert row", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar();
    const stats = await run(db, [task()], cal);
    assertEquals(stats.created, 1);
    assertEquals(cal.calls[0].op, "find"); // safety net first
    assertEquals(cal.calls[1].op, "create");
    const row = getSyncedTaskByPageId(db, "page-1");
    assert(row);
    assertEquals(row!.source, "notion");
    assertEquals(row!.googleCalendarId, "alice@co.com");
    assertEquals(row!.title, "Call client");
    assertEquals(row!.notionLastEditedAt, "2026-04-21T09:00:00.000Z");
    assertEquals(row!.lastSyncedAt, "2026-04-21T12:00:00.000Z");
  } finally {
    db.close();
  }
});

Deno.test("n2g — fresh task, safety net finds event → patch + insert row", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      findByNotionPageId: () => ({
        id: "evt-orphan",
        status: "confirmed",
        summary: "Old",
        start: { dateTime: "2026-04-21T09:00:00.000Z", timeZone: "Europe/Paris" },
        end: { dateTime: "2026-04-21T09:30:00.000Z", timeZone: "Europe/Paris" },
        updated: "2026-04-20T09:00:00.000Z",
      }),
    });
    const stats = await run(db, [task()], cal);
    assertEquals(stats.updated, 1);
    assertEquals(stats.created, 0);
    assertEquals(cal.calls.map((c) => c.op), ["find", "patch"]);
    const patchCall = cal.calls[1];
    assertEquals(patchCall.eventId, "evt-orphan");
    const row = getSyncedTaskByPageId(db, "page-1");
    assertEquals(row?.googleEventId, "evt-orphan");
    assertEquals(row?.source, "notion");
  } finally {
    db.close();
  }
});

Deno.test("n2g — existing row, same owner → patch only + row touched", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow());
    const cal = fakeCalendar();
    const stats = await run(db, [task({ title: "New title" })], cal);
    assertEquals(stats.updated, 1);
    assertEquals(cal.calls.length, 1);
    assertEquals(cal.calls[0].op, "patch");
    assertEquals(cal.calls[0].eventId, "evt-existing");
    assertEquals(cal.calls[0].userEmail, "alice@co.com");
    const row = getSyncedTaskByPageId(db, "page-1");
    assertEquals(row?.title, "New title");
    assertEquals(row?.googleEventId, "evt-existing");
    assertEquals(row?.lastSyncedAt, "2026-04-21T12:00:00.000Z");
    assertEquals(row?.notionLastEditedAt, "2026-04-21T09:00:00.000Z");
  } finally {
    db.close();
  }
});

Deno.test("n2g — existing row, different owner → delete old + create new + moved", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow());
    const cal = fakeCalendar();
    const stats = await run(db, [task({ ownerEmail: "bob@co.com" })], cal);
    assertEquals(stats.moved, 1);
    const ops = cal.calls.map((c) => `${c.op}:${c.userEmail}`);
    assertEquals(ops, ["delete:alice@co.com", "create:bob@co.com"]);
    const row = getSyncedTaskByPageId(db, "page-1");
    assertEquals(row?.googleCalendarId, "bob@co.com");
    assert(row!.googleEventId !== "evt-existing");
  } finally {
    db.close();
  }
});

Deno.test("n2g — error on one task does not block others", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      createEvent: (_user, body) => {
        if (body.summary === "Boom") throw new Error("boom");
        // Normal create path falls through for other events
        return undefined as unknown as CalendarEvent;
      },
    });
    // First task will throw on create; second will succeed.
    const stats = await run(db, [
      task({ pageId: "p-boom", title: "Boom" }),
      task({ pageId: "p-ok", title: "OK" }),
    ], cal);
    assertEquals(stats.seen, 2);
    assertEquals(stats.errors, 1);
    assertEquals(stats.created, 1);
    assertEquals(stats.errorMessages.length, 1);
    assert(stats.errorMessages[0].includes("page=p-boom"));
    assert(stats.errorMessages[0].includes("boom"));
    assert(getSyncedTaskByPageId(db, "p-ok"));
    assertEquals(getSyncedTaskByPageId(db, "p-boom"), null);
  } finally {
    db.close();
  }
});

Deno.test("n2g — errorMessages capped at 5", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      createEvent: () => {
        throw new Error("always fails");
      },
    });
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ pageId: `p-${i}`, title: `T${i}` }));
    const stats = await run(db, tasks, cal);
    assertEquals(stats.errors, 10);
    assertEquals(stats.errorMessages.length, 5);
  } finally {
    db.close();
  }
});

Deno.test("n2g — body sent for dated event carries timezone on start and end", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar();
    await run(db, [task()], cal);
    const create = cal.calls.find((c) => c.op === "create");
    const body = create?.body as EventCreateBody;
    assertEquals(body.start, {
      dateTime: "2026-04-21T10:00:00.000Z",
      timeZone: "Europe/Paris",
    });
    assertEquals(body.extendedProperties?.private?.notion_page_id, "page-1");
  } finally {
    db.close();
  }
});
