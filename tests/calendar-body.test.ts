import { assertEquals } from "jsr:@std/assert@^1";
import {
  addDaysToYmd,
  addMinutesToIso,
  buildEventBodyFromTask,
} from "../sync-n2g.ts";
import type { NotionTask } from "../notion.ts";

const CFG = { defaultEventDurationMin: 30, timezone: "Europe/Paris" };

function baseTask(overrides: Partial<NotionTask> = {}): NotionTask {
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

Deno.test("addDaysToYmd — simple, month rollover, year rollover", () => {
  assertEquals(addDaysToYmd("2026-04-21", 1), "2026-04-22");
  assertEquals(addDaysToYmd("2026-04-30", 1), "2026-05-01");
  assertEquals(addDaysToYmd("2026-12-31", 1), "2027-01-01");
  assertEquals(addDaysToYmd("2024-02-28", 1), "2024-02-29"); // leap year
});

Deno.test("addMinutesToIso — simple addition", () => {
  assertEquals(
    addMinutesToIso("2026-04-21T10:00:00.000Z", 30),
    "2026-04-21T10:30:00.000Z",
  );
  assertEquals(
    addMinutesToIso("2026-04-21T23:45:00.000Z", 30),
    "2026-04-22T00:15:00.000Z",
  );
});

Deno.test("buildEventBodyFromTask — dated event without end uses default duration", () => {
  const body = buildEventBodyFromTask(baseTask(), CFG);
  assertEquals(body.start, {
    dateTime: "2026-04-21T10:00:00.000Z",
    timeZone: "Europe/Paris",
  });
  assertEquals(body.end, {
    dateTime: "2026-04-21T10:30:00.000Z",
    timeZone: "Europe/Paris",
  });
  assertEquals(body.summary, "Call client");
  assertEquals(body.description, "Source Notion: https://www.notion.so/page-1");
  assertEquals(body.extendedProperties?.private?.notion_page_id, "page-1");
});

Deno.test("buildEventBodyFromTask — dated event with explicit end preserves end", () => {
  const body = buildEventBodyFromTask(
    baseTask({
      dateStart: "2026-04-21T10:00:00.000Z",
      dateEnd: "2026-04-21T12:00:00.000Z",
    }),
    CFG,
  );
  assertEquals(body.end, {
    dateTime: "2026-04-21T12:00:00.000Z",
    timeZone: "Europe/Paris",
  });
});

Deno.test("buildEventBodyFromTask — dated event always carries configured timeZone on start/end", () => {
  const body = buildEventBodyFromTask(
    baseTask({ dateStart: "2026-04-21T10:00:00+02:00", dateEnd: null }),
    CFG,
  );
  assertEquals(body.start?.timeZone, "Europe/Paris");
  assertEquals(body.end?.timeZone, "Europe/Paris");
  assertEquals(body.start?.dateTime, "2026-04-21T10:00:00+02:00");
});

Deno.test("buildEventBodyFromTask — all-day single day uses exclusive end (start+1)", () => {
  const body = buildEventBodyFromTask(
    baseTask({ dateStart: "2026-04-21", dateEnd: null, isAllDay: true }),
    CFG,
  );
  assertEquals(body.start, { date: "2026-04-21" });
  assertEquals(body.end, { date: "2026-04-22" });
});

Deno.test("buildEventBodyFromTask — all-day multi-day uses exclusive end (dateEnd+1)", () => {
  const body = buildEventBodyFromTask(
    baseTask({ dateStart: "2026-04-21", dateEnd: "2026-04-23", isAllDay: true }),
    CFG,
  );
  assertEquals(body.start, { date: "2026-04-21" });
  assertEquals(body.end, { date: "2026-04-24" });
});

Deno.test("buildEventBodyFromTask — all-day does not carry timeZone", () => {
  const body = buildEventBodyFromTask(
    baseTask({ dateStart: "2026-04-21", dateEnd: null, isAllDay: true }),
    CFG,
  );
  assertEquals(body.start?.timeZone, undefined);
  assertEquals(body.end?.timeZone, undefined);
});
