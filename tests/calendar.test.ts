import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  type CalendarEvent,
  createCalendarClient,
  SyncTokenExpiredError,
} from "../calendar.ts";
import type { GoogleAuth } from "../google-auth.ts";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface FakeFetchConfig {
  responder: (call: FetchCall) => Response | Promise<Response>;
}

function fakeAuth(): GoogleAuth {
  return {
    getAccessToken: (email) => Promise.resolve(`tok-${email}`),
    invalidate: () => {},
  };
}

function captureFetch(cfg: FakeFetchConfig): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = async (input, rawInit) => {
    const init = (rawInit ?? {}) as RequestInit;
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = (init.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const rawBody = init.body;
    const body = rawBody === undefined || rawBody === null
      ? null
      : typeof rawBody === "string"
      ? rawBody
      : "<non-string-body>";
    const call: FetchCall = { url, method: init.method ?? "GET", headers, body };
    calls.push(call);
    return await cfg.responder(call);
  };
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Call client",
    start: { dateTime: "2026-04-21T10:00:00+02:00", timeZone: "Europe/Paris" },
    end: { dateTime: "2026-04-21T10:30:00+02:00", timeZone: "Europe/Paris" },
    updated: "2026-04-21T09:00:00.000Z",
    ...overrides,
  };
}

Deno.test("createEvent — POSTs JSON with Bearer token for the sub", async () => {
  const created = makeEvent();
  const { fn, calls } = captureFetch({
    responder: () => jsonResponse(created),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  const out = await client.createEvent("alice@co.com", {
    summary: "Call client",
    start: created.start,
    end: created.end,
    extendedProperties: { private: { notion_page_id: "page-1" } },
  });
  assertEquals(out, created);
  assertEquals(calls.length, 1);
  const call = calls[0];
  assertEquals(call.method, "POST");
  assert(
    call.url.startsWith(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    ),
  );
  assertEquals(call.headers["authorization"], "Bearer tok-alice@co.com");
  assertEquals(call.headers["content-type"], "application/json");
  const sent = JSON.parse(call.body!);
  assertEquals(sent.summary, "Call client");
  assertEquals(sent.extendedProperties.private.notion_page_id, "page-1");
});

Deno.test("patchEvent — PATCHes /events/{id} with partial body", async () => {
  const { fn, calls } = captureFetch({
    responder: () => jsonResponse(makeEvent({ summary: "New title" })),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await client.patchEvent("alice@co.com", "evt-1", { summary: "New title" });
  const call = calls[0];
  assertEquals(call.method, "PATCH");
  assert(call.url.endsWith("/calendars/primary/events/evt-1"));
  assertEquals(JSON.parse(call.body!), { summary: "New title" });
});

Deno.test("patchEvent — URL-encodes event id", async () => {
  const { fn, calls } = captureFetch({
    responder: () => jsonResponse(makeEvent()),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await client.patchEvent("alice@co.com", "evt/with space", {});
  assert(calls[0].url.endsWith("evt%2Fwith%20space"));
});

Deno.test("getEvent — returns event on 200", async () => {
  const { fn, calls } = captureFetch({
    responder: () => jsonResponse(makeEvent({ id: "evt-42" })),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  const out = await client.getEvent("alice@co.com", "evt-42");
  assertEquals(out?.id, "evt-42");
  assertEquals(calls[0].method, "GET");
  assert(calls[0].url.endsWith("/calendars/primary/events/evt-42"));
});

Deno.test("getEvent — returns null on 404", async () => {
  const { fn } = captureFetch({
    responder: () => new Response("not found", { status: 404 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  assertEquals(await client.getEvent("alice@co.com", "ghost"), null);
});

Deno.test("getEvent — returns null on 410 Gone", async () => {
  const { fn } = captureFetch({
    responder: () => new Response("gone", { status: 410 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  assertEquals(await client.getEvent("alice@co.com", "ghost"), null);
});

Deno.test("getEvent — throws on 500", async () => {
  const { fn } = captureFetch({
    responder: () => new Response("boom", { status: 500 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await assertRejects(
    () => client.getEvent("alice@co.com", "evt-1"),
    Error,
    "calendar.getEvent failed",
  );
});

Deno.test("deleteEvent — swallows 404", async () => {
  const { fn } = captureFetch({
    responder: () => new Response(null, { status: 404 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await client.deleteEvent("alice@co.com", "evt-1");
});

Deno.test("deleteEvent — swallows 410", async () => {
  const { fn } = captureFetch({
    responder: () => new Response(null, { status: 410 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await client.deleteEvent("alice@co.com", "evt-1");
});

Deno.test("deleteEvent — throws on 500", async () => {
  const { fn } = captureFetch({
    responder: () => new Response("boom", { status: 500 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await assertRejects(
    () => client.deleteEvent("alice@co.com", "evt-1"),
    Error,
    "calendar.deleteEvent failed",
  );
});

Deno.test("deleteEvent — treats 204 No Content as success", async () => {
  const { fn } = captureFetch({
    responder: () => new Response(null, { status: 204 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await client.deleteEvent("alice@co.com", "evt-1");
});

Deno.test("findByNotionPageId — sets privateExtendedProperty query and returns first item", async () => {
  const { fn, calls } = captureFetch({
    responder: () => jsonResponse({ items: [makeEvent({ id: "evt-found" })] }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  const out = await client.findByNotionPageId("alice@co.com", "page-1");
  assertEquals(out?.id, "evt-found");
  const parsed = new URL(calls[0].url);
  assertEquals(
    parsed.searchParams.get("privateExtendedProperty"),
    "notion_page_id=page-1",
  );
  assertEquals(parsed.searchParams.get("maxResults"), "1");
});

Deno.test("findByNotionPageId — returns null when no match", async () => {
  const { fn } = captureFetch({
    responder: () => jsonResponse({ items: [] }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  const out = await client.findByNotionPageId("alice@co.com", "page-missing");
  assertEquals(out, null);
});

Deno.test("listPage — uses syncToken when provided, skips timeMin/timeMax", async () => {
  const { fn, calls } = captureFetch({
    responder: () =>
      jsonResponse({
        items: [makeEvent()],
        nextSyncToken: "sync-2",
      }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  const page = await client.listPage("alice@co.com", {
    syncToken: "sync-1",
    timeMin: "should-not-appear",
    timeMax: "should-not-appear",
  });
  const url = new URL(calls[0].url);
  assertEquals(url.searchParams.get("syncToken"), "sync-1");
  assertEquals(url.searchParams.get("timeMin"), null);
  assertEquals(url.searchParams.get("timeMax"), null);
  assertEquals(url.searchParams.get("singleEvents"), "true");
  assertEquals(url.searchParams.get("showDeleted"), "true");
  assertEquals(page.events.length, 1);
  assertEquals(page.nextSyncToken, "sync-2");
  assertEquals(page.nextPageToken, null);
});

Deno.test("listPage — uses timeMin/timeMax in full-list mode", async () => {
  const { fn, calls } = captureFetch({
    responder: () => jsonResponse({ items: [] }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await client.listPage("alice@co.com", {
    timeMin: "2026-04-11T00:00:00Z",
    timeMax: "2026-05-01T00:00:00Z",
  });
  const url = new URL(calls[0].url);
  assertEquals(url.searchParams.get("timeMin"), "2026-04-11T00:00:00Z");
  assertEquals(url.searchParams.get("timeMax"), "2026-05-01T00:00:00Z");
  assertEquals(url.searchParams.get("syncToken"), null);
});

Deno.test("listPage — 410 throws SyncTokenExpiredError", async () => {
  const { fn } = captureFetch({
    responder: () => new Response("Gone", { status: 410 }),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  await assertRejects(
    () => client.listPage("alice@co.com", { syncToken: "expired" }),
    SyncTokenExpiredError,
  );
});

Deno.test("listAll — paginates and picks up nextSyncToken on last page", async () => {
  let callIdx = 0;
  const pages = [
    {
      items: [makeEvent({ id: "e1" })],
      nextPageToken: "page-2",
    },
    {
      items: [makeEvent({ id: "e2" }), makeEvent({ id: "e3" })],
      nextPageToken: "page-3",
    },
    {
      items: [makeEvent({ id: "e4" })],
      nextSyncToken: "final-sync",
    },
  ];
  const expectedTokens: (string | undefined)[] = [undefined, "page-2", "page-3"];
  const { fn, calls } = captureFetch({
    responder: () => jsonResponse(pages[callIdx++]),
  });
  const client = createCalendarClient(fakeAuth(), { fetchFn: fn });
  const out = await client.listAll("alice@co.com", { timeMin: "t0", timeMax: "t1" });
  assertEquals(out.events.map((e) => e.id), ["e1", "e2", "e3", "e4"]);
  assertEquals(out.nextSyncToken, "final-sync");
  assertEquals(calls.length, 3);
  for (let i = 0; i < 3; i++) {
    const url = new URL(calls[i].url);
    assertEquals(url.searchParams.get("pageToken"), expectedTokens[i] ?? null);
  }
});

Deno.test("request — retries once on 429 after sleep", async () => {
  let calls = 0;
  const slept: number[] = [];
  const fn: typeof fetch = () => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    }
    return Promise.resolve(jsonResponse(makeEvent()));
  };
  const client = createCalendarClient(fakeAuth(), {
    fetchFn: fn,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  await client.createEvent("alice@co.com", {
    summary: "x",
    start: { date: "2026-04-21" },
    end: { date: "2026-04-22" },
  });
  assertEquals(calls, 2);
  assertEquals(slept, [2000]);
});

Deno.test("request — does not retry if second 429 also fails", async () => {
  let calls = 0;
  const fn: typeof fetch = () => {
    calls++;
    return Promise.resolve(new Response("rate limited", { status: 429 }));
  };
  const client = createCalendarClient(fakeAuth(), {
    fetchFn: fn,
    sleep: () => Promise.resolve(),
  });
  await assertRejects(
    () =>
      client.createEvent("alice@co.com", {
        summary: "x",
        start: { date: "2026-04-21" },
        end: { date: "2026-04-22" },
      }),
    Error,
    "calendar.createEvent failed",
  );
  assertEquals(calls, 2);
});
