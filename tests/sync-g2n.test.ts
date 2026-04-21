import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  type Database,
  getSyncedTaskByEventId,
  getSyncedTaskByPageId,
  getSyncToken,
  openDatabase,
  type SyncedTask,
  upsertSyncedTask,
  upsertSyncToken,
} from "../db.ts";
import type {
  CalendarClient,
  CalendarEvent,
  EventCreateBody,
  EventPatchBody,
  ListParams,
} from "../calendar.ts";
import { SyncTokenExpiredError } from "../calendar.ts";
import type {
  CreateTaskArgs,
  NotionService,
  NotionUser,
  UpdateTaskArgs,
} from "../notion.ts";
import {
  runSyncG2N,
  SEED_LOOKAHEAD_DAYS,
  SEED_LOOKBACK_DAYS,
  type SyncG2NConfig,
} from "../sync-g2n.ts";

const CFG: SyncG2NConfig = {
  watchEmails: ["alice@co.com"],
  syncKeyword: "NOTION",
  timezone: "Europe/Paris",
};

const NOW = new Date("2026-04-21T12:00:00.000Z");

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "NOTION: Q3 planning",
    start: { dateTime: "2026-04-22T10:00:00.000Z", timeZone: "Europe/Paris" },
    end: { dateTime: "2026-04-22T11:00:00.000Z", timeZone: "Europe/Paris" },
    updated: "2026-04-21T09:00:00.000Z",
    ...overrides,
  };
}

interface ListAllCall {
  email: string;
  params: ListParams;
}

interface PatchCall {
  email: string;
  eventId: string;
  body: EventPatchBody;
}

interface NotionCall {
  op: "create" | "update" | "archive" | "users";
  args?: CreateTaskArgs | UpdateTaskArgs | { pageId: string };
}

function fakeCalendar(opts: {
  listAllResponses: Array<
    | { events: CalendarEvent[]; nextSyncToken: string | null }
    | SyncTokenExpiredError
  >;
  patchReturns?: (email: string, eventId: string, body: EventPatchBody) => CalendarEvent;
}): CalendarClient & {
  listCalls: ListAllCall[];
  patchCalls: PatchCall[];
} {
  const listCalls: ListAllCall[] = [];
  const patchCalls: PatchCall[] = [];
  let listIdx = 0;
  return {
    listCalls,
    patchCalls,
    listAll: (email, params) => {
      listCalls.push({ email, params });
      const r = opts.listAllResponses[listIdx++];
      if (r instanceof SyncTokenExpiredError) return Promise.reject(r);
      return Promise.resolve(r);
    },
    patchEvent: (email, eventId, body) => {
      patchCalls.push({ email, eventId, body });
      const evt = opts.patchReturns?.(email, eventId, body) ?? {
        id: eventId,
        status: "confirmed",
        summary: body.summary ?? "x",
        start: body.start ?? { date: "2026-04-22" },
        end: body.end ?? { date: "2026-04-23" },
        updated: "2026-04-21T09:05:00.000Z",
        extendedProperties: body.extendedProperties,
      };
      return Promise.resolve(evt);
    },
    createEvent: () => {
      throw new Error("createEvent should not be called in g2n");
    },
    deleteEvent: () => {
      throw new Error("deleteEvent should not be called in g2n");
    },
    getEvent: () => {
      throw new Error("getEvent should not be called in g2n");
    },
    findByNotionPageId: () => {
      throw new Error("findByNotionPageId should not be called in g2n");
    },
    listPage: () => {
      throw new Error("listPage should not be called in g2n");
    },
  };
}

function fakeNotion(opts: {
  users?: NotionUser[];
  onCreate?: (args: CreateTaskArgs) => { pageId: string; lastEditedAt: string };
  onUpdate?: (args: UpdateTaskArgs) => { lastEditedAt: string };
  onArchive?: (pageId: string) => void;
}): NotionService & { calls: NotionCall[] } {
  const calls: NotionCall[] = [];
  return {
    calls,
    listUsers: () => {
      calls.push({ op: "users" });
      return Promise.resolve(opts.users ?? []);
    },
    createTaskPage: (args) => {
      calls.push({ op: "create", args });
      return Promise.resolve(
        opts.onCreate?.(args) ??
          { pageId: "page-new", lastEditedAt: "2026-04-21T12:00:00.000Z" },
      );
    },
    updateTaskPage: (args) => {
      calls.push({ op: "update", args });
      return Promise.resolve(
        opts.onUpdate?.(args) ?? { lastEditedAt: "2026-04-21T12:00:00.000Z" },
      );
    },
    archiveTaskPage: (pageId) => {
      calls.push({ op: "archive", args: { pageId } });
      opts.onArchive?.(pageId);
      return Promise.resolve();
    },
    queryTasksSince: () => Promise.resolve([]),
    queryAllTasks: () => Promise.resolve([]),
  };
}

function makeRow(overrides: Partial<SyncedTask> = {}): SyncedTask {
  return {
    notionPageId: "page-existing",
    googleEventId: "evt-1",
    googleCalendarId: "alice@co.com",
    source: "google",
    notionLastEditedAt: "2026-04-21T08:00:00.000Z",
    googleUpdatedAt: "2026-04-21T08:00:00.000Z",
    lastSyncedAt: "2026-04-21T08:00:00.000Z",
    title: "Old title",
    ...overrides,
  };
}

function runWith(
  db: Database,
  cal: CalendarClient,
  notion: NotionService,
  cfg: Partial<SyncG2NConfig> = {},
): ReturnType<typeof runSyncG2N> {
  return runSyncG2N({
    db,
    notion,
    calendar: cal,
    config: { ...CFG, ...cfg },
    now: () => NOW,
  });
}

// -- Empty allowlist ---------------------------------------------------------

Deno.test("g2n — empty watch emails disables the pass completely", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({ listAllResponses: [] });
    const notion = fakeNotion({});
    const stats = await runWith(db, cal, notion, { watchEmails: [] });
    assertEquals(stats.seen, 0);
    assertEquals(cal.listCalls.length, 0);
    assertEquals(notion.calls.length, 0);
  } finally {
    db.close();
  }
});

// -- Cancelled --------------------------------------------------------------

Deno.test("g2n — cancelled event with row → archive Notion + delete row", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(db, makeRow());
    const cal = fakeCalendar({
      listAllResponses: [{
        events: [makeEvent({ status: "cancelled" })],
        nextSyncToken: "tok-next",
      }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.deleted, 1);
    assertEquals(getSyncedTaskByPageId(db, "page-existing"), null);
    const archive = notion.calls.find((c) => c.op === "archive");
    assertEquals((archive!.args as { pageId: string }).pageId, "page-existing");
  } finally {
    db.close();
  }
});

Deno.test("g2n — cancelled event without row → skipped", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      listAllResponses: [{
        events: [makeEvent({ status: "cancelled" })],
        nextSyncToken: "tok-next",
      }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.skipped, 1);
    assertEquals(stats.deleted, 0);
    assert(notion.calls.every((c) => c.op !== "archive"));
  } finally {
    db.close();
  }
});

// -- Notion-origin events are always skipped --------------------------------

Deno.test("g2n — event carrying notion_page_id is skipped regardless of title", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      listAllResponses: [{
        events: [makeEvent({
          summary: "NOTION: Looks like ingestion",
          extendedProperties: { private: { notion_page_id: "page-owner" } },
        })],
        nextSyncToken: "tok-next",
      }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.skipped, 1);
    assertEquals(stats.created, 0);
    assertEquals(cal.patchCalls.length, 0);
  } finally {
    db.close();
  }
});

// -- Fresh ingestion --------------------------------------------------------

Deno.test("g2n — fresh matching event → create page, seal event, insert row", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      listAllResponses: [{
        events: [makeEvent()],
        nextSyncToken: "tok-next",
      }],
    });
    const notion = fakeNotion({
      users: [{ id: "user-alice", name: "Alice", email: "alice@co.com" }],
      onCreate: () => ({ pageId: "page-new", lastEditedAt: "2026-04-21T12:00:00.000Z" }),
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.created, 1);

    const create = notion.calls.find((c) => c.op === "create");
    const args = create!.args as CreateTaskArgs;
    assertEquals(args.title, "Q3 planning");
    assertEquals(args.ownerUserId, "user-alice");
    assertEquals(args.isAllDay, false);
    assertEquals(args.dateStart, "2026-04-22T10:00:00.000Z");
    assertEquals(args.timezone, "Europe/Paris");

    assertEquals(cal.patchCalls.length, 1);
    assertEquals(cal.patchCalls[0].eventId, "evt-1");
    assertEquals(cal.patchCalls[0].body.summary, "Q3 planning");
    assertEquals(
      cal.patchCalls[0].body.extendedProperties?.private?.notion_page_id,
      "page-new",
    );

    const row = getSyncedTaskByEventId(db, "evt-1");
    assert(row);
    assertEquals(row!.source, "google");
    assertEquals(row!.notionPageId, "page-new");
    assertEquals(row!.title, "Q3 planning");
    assertEquals(row!.googleUpdatedAt, "2026-04-21T09:05:00.000Z"); // sealed mtime
    assertEquals(getSyncToken(db, "alice@co.com"), "tok-next");
  } finally {
    db.close();
  }
});

Deno.test("g2n — fresh matching event but no Notion user for email → skipped + warn", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      listAllResponses: [{ events: [makeEvent()], nextSyncToken: null }],
    });
    const notion = fakeNotion({
      users: [{ id: "u-other", name: "Other", email: "other@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.skipped, 1);
    assertEquals(stats.created, 0);
    assertEquals(cal.patchCalls.length, 0);
  } finally {
    db.close();
  }
});

Deno.test("g2n — fresh event without marker → skipped, no Notion call", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      listAllResponses: [{
        events: [makeEvent({ summary: "Daily standup" })],
        nextSyncToken: "tok-next",
      }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.skipped, 1);
    assertEquals(notion.calls.filter((c) => c.op === "create").length, 0);
  } finally {
    db.close();
  }
});

// -- Linked event updates ---------------------------------------------------

Deno.test("g2n — linked event with newer event.updated → Notion update", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(
      db,
      makeRow({ googleUpdatedAt: "2026-04-21T08:00:00.000Z" }),
    );
    const cal = fakeCalendar({
      listAllResponses: [{
        events: [makeEvent({
          summary: "Q3 planning — updated",
          updated: "2026-04-21T09:00:00.000Z",
        })],
        nextSyncToken: "tok-next",
      }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.updated, 1);
    const upd = notion.calls.find((c) => c.op === "update");
    const args = upd!.args as UpdateTaskArgs;
    assertEquals(args.title, "Q3 planning — updated"); // no re-stripping of keyword
    assertEquals(args.pageId, "page-existing");
    const row = getSyncedTaskByEventId(db, "evt-1");
    assertEquals(row!.googleUpdatedAt, "2026-04-21T09:00:00.000Z");
  } finally {
    db.close();
  }
});

Deno.test("g2n — linked event with same-or-older event.updated → skipped (own echo)", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncedTask(
      db,
      makeRow({ googleUpdatedAt: "2026-04-21T09:00:00.000Z" }),
    );
    const cal = fakeCalendar({
      listAllResponses: [{
        events: [makeEvent({ updated: "2026-04-21T09:00:00.000Z" })],
        nextSyncToken: "tok-next",
      }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.skipped, 1);
    assertEquals(stats.updated, 0);
    assert(notion.calls.every((c) => c.op !== "update"));
  } finally {
    db.close();
  }
});

// -- Seed window ------------------------------------------------------------

Deno.test("g2n — first call (no syncToken) uses seed window now ± 10d", async () => {
  const db = openDatabase(":memory:");
  try {
    const cal = fakeCalendar({
      listAllResponses: [{ events: [], nextSyncToken: "tok-fresh" }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    await runWith(db, cal, notion);
    assertEquals(cal.listCalls.length, 1);
    const params = cal.listCalls[0].params;
    assertEquals(params.syncToken, undefined);
    const expectedMin = new Date(
      NOW.getTime() - SEED_LOOKBACK_DAYS * 86_400_000,
    ).toISOString();
    const expectedMax = new Date(
      NOW.getTime() + SEED_LOOKAHEAD_DAYS * 86_400_000,
    ).toISOString();
    assertEquals(params.timeMin, expectedMin);
    assertEquals(params.timeMax, expectedMax);
    assertEquals(getSyncToken(db, "alice@co.com"), "tok-fresh");
  } finally {
    db.close();
  }
});

Deno.test("g2n — subsequent call uses stored syncToken, not seed window", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncToken(db, "alice@co.com", "tok-saved");
    const cal = fakeCalendar({
      listAllResponses: [{ events: [], nextSyncToken: "tok-next" }],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    await runWith(db, cal, notion);
    const params = cal.listCalls[0].params;
    assertEquals(params.syncToken, "tok-saved");
    assertEquals(params.timeMin, undefined);
    assertEquals(params.timeMax, undefined);
    assertEquals(getSyncToken(db, "alice@co.com"), "tok-next");
  } finally {
    db.close();
  }
});

// -- 410 → full resync ------------------------------------------------------

Deno.test("g2n — 410 on listAll drops token and retries in full list mode", async () => {
  const db = openDatabase(":memory:");
  try {
    upsertSyncToken(db, "alice@co.com", "tok-expired");
    const cal = fakeCalendar({
      listAllResponses: [
        new SyncTokenExpiredError("alice@co.com"),
        { events: [makeEvent({ id: "evt-recovered" })], nextSyncToken: "tok-fresh" },
      ],
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
      onCreate: () => ({ pageId: "page-fresh", lastEditedAt: "2026-04-21T12:00:00.000Z" }),
    });
    const stats = await runWith(db, cal, notion);

    assertEquals(cal.listCalls.length, 2);
    // First call used the expired token.
    assertEquals(cal.listCalls[0].params.syncToken, "tok-expired");
    // Second call is in seed mode.
    assertEquals(cal.listCalls[1].params.syncToken, undefined);
    assert(cal.listCalls[1].params.timeMin !== undefined);
    assert(cal.listCalls[1].params.timeMax !== undefined);

    // Events from the retry were processed (no double-counting).
    assertEquals(stats.created, 1);
    assertEquals(getSyncToken(db, "alice@co.com"), "tok-fresh");
  } finally {
    db.close();
  }
});

// -- Error isolation --------------------------------------------------------

Deno.test("g2n — error on one event does not block others, capped at 5", async () => {
  const db = openDatabase(":memory:");
  try {
    const events = Array.from({ length: 7 }, (_, i) =>
      makeEvent({ id: `evt-${i}`, summary: "NOTION: fail" }));
    const cal = fakeCalendar({
      listAllResponses: [{ events, nextSyncToken: "tok-next" }],
      patchReturns: () => {
        throw new Error("seal-failure");
      },
    });
    const notion = fakeNotion({
      users: [{ id: "u1", name: "Alice", email: "alice@co.com" }],
    });
    const stats = await runWith(db, cal, notion);
    assertEquals(stats.errors, 7);
    assertEquals(stats.errorMessages.length, 5);
    assertEquals(stats.created, 0);
  } finally {
    db.close();
  }
});
