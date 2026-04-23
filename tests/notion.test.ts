import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Client as NotionClient } from "@notionhq/client";
import {
  buildDateProperty,
  buildTitleProperty,
  createNotionService,
  type NotionSchemaConfig,
  parseNotionPage,
} from "../notion.ts";

const SCHEMA: NotionSchemaConfig = {
  propTitle: "Name",
  propDate: "Date",
  propOwner: "Owner",
  propStatus: "Status",
  statusArchivedValues: ["Archived", "Done", "Cancelled"],
};

function pageFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "page-1",
    url: "https://www.notion.so/page-1",
    archived: false,
    last_edited_time: "2026-04-21T09:00:00.000Z",
    properties: {
      Name: { type: "title", title: [{ plain_text: "Call client" }] },
      Date: {
        type: "date",
        date: { start: "2026-04-21T10:00:00.000Z", end: null, time_zone: null },
      },
      Owner: {
        type: "people",
        people: [{
          id: "user-1",
          name: "Alice",
          person: { email: "alice@co.com" },
        }],
      },
      Status: { type: "status", status: { name: "In progress" } },
    },
    ...overrides,
  };
}

Deno.test("parseNotionPage — happy path, dated event", () => {
  const task = parseNotionPage(pageFixture(), SCHEMA);
  assert(task);
  assertEquals(task!.pageId, "page-1");
  assertEquals(task!.title, "Call client");
  assertEquals(task!.dateStart, "2026-04-21T10:00:00.000Z");
  assertEquals(task!.dateEnd, null);
  assertEquals(task!.isAllDay, false);
  assertEquals(task!.ownerEmail, "alice@co.com");
  assertEquals(task!.ownerName, "Alice");
  assertEquals(task!.statusValue, "In progress");
  assertEquals(task!.isArchived, false);
});

Deno.test("parseNotionPage — all-day when start has no T", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Date: { type: "date", date: { start: "2026-04-21", end: null, time_zone: null } },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.isAllDay, true);
});

Deno.test("parseNotionPage — empty title yields \"\"", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Name: { type: "title", title: [] },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.title, "");
});

Deno.test("parseNotionPage — title made of multiple rich text nodes is concatenated", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Name: {
          type: "title",
          title: [{ plain_text: "Call " }, { plain_text: "client" }],
        },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.title, "Call client");
});

Deno.test("parseNotionPage — owner multi, keeps first", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Owner: {
          type: "people",
          people: [
            { id: "u1", name: "Alice", person: { email: "alice@co.com" } },
            { id: "u2", name: "Bob", person: { email: "bob@co.com" } },
          ],
        },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.ownerEmail, "alice@co.com");
});

Deno.test("parseNotionPage — owner absent → email null, name null", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Owner: { type: "people", people: [] },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.ownerEmail, null);
  assertEquals(task?.ownerName, null);
});

Deno.test("parseNotionPage — owner without email (missing capability)", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Owner: {
          type: "people",
          people: [{ id: "u1", name: "Alice", person: {} }],
        },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.ownerEmail, null);
  assertEquals(task?.ownerName, "Alice");
});

Deno.test("parseNotionPage — status disabled when propStatus is null", () => {
  const task = parseNotionPage(pageFixture(), { ...SCHEMA, propStatus: null });
  assertEquals(task?.statusValue, null);
  assertEquals(task?.isArchived, false);
});

Deno.test("parseNotionPage — select property type is read when schema is a Select", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Status: { type: "select", select: { name: "Done" } },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.statusValue, "Done");
  assertEquals(task?.isArchived, true);
});

Deno.test("parseNotionPage — archived when status is in archived values", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Status: { type: "status", status: { name: "Cancelled" } },
      },
    }),
    SCHEMA,
  );
  assertEquals(task?.isArchived, true);
});

Deno.test("parseNotionPage — archived when page.archived is true, even without status match", () => {
  const task = parseNotionPage(pageFixture({ archived: true }), SCHEMA);
  assertEquals(task?.isArchived, true);
});

Deno.test("parseNotionPage — returns null when date is missing", () => {
  const task = parseNotionPage(
    pageFixture({
      properties: {
        ...(pageFixture() as { properties: Record<string, unknown> }).properties,
        Date: { type: "date", date: null },
      },
    }),
    SCHEMA,
  );
  assertEquals(task, null);
});

Deno.test("buildDateProperty — all-day uses time_zone null", () => {
  assertEquals(buildDateProperty("2026-04-21", null, true, "Europe/Paris"), {
    date: { start: "2026-04-21", end: null, time_zone: null },
  });
});

Deno.test("buildDateProperty — dated uses configured timezone", () => {
  assertEquals(
    buildDateProperty("2026-04-21T10:00:00.000Z", "2026-04-21T11:00:00.000Z", false, "Europe/Paris"),
    {
      date: {
        start: "2026-04-21T10:00:00.000Z",
        end: "2026-04-21T11:00:00.000Z",
        time_zone: "Europe/Paris",
      },
    },
  );
});

Deno.test("buildTitleProperty — wraps into Notion rich text", () => {
  assertEquals(buildTitleProperty("Hi"), {
    title: [{ type: "text", text: { content: "Hi" } }],
  });
});

// -- NotionService -----------------------------------------------------------

interface FakeCalls {
  queries: unknown[];
  creates: unknown[];
  updates: unknown[];
  userLists: unknown[];
}

function fakeClient(responders: {
  query?: (args: unknown) => unknown;
  create?: (args: unknown) => unknown;
  update?: (args: unknown) => unknown;
  list?: (args: unknown) => unknown;
}): { client: NotionClient; calls: FakeCalls } {
  const calls: FakeCalls = { queries: [], creates: [], updates: [], userLists: [] };
  const client = {
    databases: {
      retrieve: (_args: unknown) =>
        Promise.resolve({ data_sources: [{ id: "ds-1", name: "main" }] }),
    },
    dataSources: {
      query: (args: unknown) => {
        calls.queries.push(args);
        return Promise.resolve(
          responders.query?.(args) ?? { results: [], has_more: false, next_cursor: null },
        );
      },
    },
    pages: {
      create: (args: unknown) => {
        calls.creates.push(args);
        return Promise.resolve(
          responders.create?.(args) ??
            { id: "new-page", last_edited_time: "2026-04-21T09:00:00.000Z" },
        );
      },
      update: (args: unknown) => {
        calls.updates.push(args);
        return Promise.resolve(
          responders.update?.(args) ?? { last_edited_time: "2026-04-21T09:00:00.000Z" },
        );
      },
    },
    users: {
      list: (args: unknown) => {
        calls.userLists.push(args);
        return Promise.resolve(
          responders.list?.(args) ?? { results: [], has_more: false, next_cursor: null },
        );
      },
    },
  } as unknown as NotionClient;
  return { client, calls };
}

Deno.test("queryTasksSince — sends combined filter and paginates", async () => {
  let call = 0;
  const { client, calls } = fakeClient({
    query: () => {
      call++;
      if (call === 1) {
        return {
          results: [pageFixture({ id: "p1" })],
          has_more: true,
          next_cursor: "c1",
        };
      }
      return {
        results: [pageFixture({ id: "p2" })],
        has_more: false,
        next_cursor: null,
      };
    },
  });
  const svc = createNotionService(client, { databaseId: "db-1", schema: SCHEMA });
  const tasks = await svc.queryTasksSince("2026-04-21T00:00:00.000Z");
  assertEquals(tasks.map((t) => t.pageId), ["p1", "p2"]);
  assertEquals(calls.queries.length, 2);
  const first = calls.queries[0] as { filter: { and: unknown[] }; start_cursor?: string };
  assertEquals(first.filter.and.length, 2);
  assertEquals(first.start_cursor, undefined);
  const second = calls.queries[1] as { start_cursor?: string };
  assertEquals(second.start_cursor, "c1");
});

Deno.test("queryAllTasks — filter is just date is_not_empty", async () => {
  const { client, calls } = fakeClient({});
  const svc = createNotionService(client, { databaseId: "db-1", schema: SCHEMA });
  await svc.queryAllTasks();
  const sent = calls.queries[0] as { filter: Record<string, unknown> };
  assertEquals(sent.filter, { property: "Date", date: { is_not_empty: true } });
});

Deno.test("createTaskPage — sends title, date with tz, people", async () => {
  const { client, calls } = fakeClient({
    create: () => ({ id: "new", last_edited_time: "2026-04-21T09:00:00.000Z" }),
  });
  const svc = createNotionService(client, { databaseId: "db-1", schema: SCHEMA });
  const out = await svc.createTaskPage({
    title: "Call client",
    dateStart: "2026-04-21T10:00:00.000Z",
    dateEnd: null,
    isAllDay: false,
    ownerUserId: "user-1",
    timezone: "Europe/Paris",
  });
  assertEquals(out, { pageId: "new", lastEditedAt: "2026-04-21T09:00:00.000Z" });
  const sent = calls.creates[0] as {
    parent: { database_id: string };
    properties: Record<string, unknown>;
  };
  assertEquals(sent.parent.database_id, "db-1");
  assertEquals(sent.properties["Name"], {
    title: [{ type: "text", text: { content: "Call client" } }],
  });
  assertEquals(sent.properties["Date"], {
    date: {
      start: "2026-04-21T10:00:00.000Z",
      end: null,
      time_zone: "Europe/Paris",
    },
  });
  assertEquals(sent.properties["Owner"], { people: [{ id: "user-1" }] });
});

Deno.test("createTaskPage — all-day sends time_zone null", async () => {
  const { client, calls } = fakeClient({});
  const svc = createNotionService(client, { databaseId: "db-1", schema: SCHEMA });
  await svc.createTaskPage({
    title: "Holiday",
    dateStart: "2026-04-21",
    dateEnd: null,
    isAllDay: true,
    ownerUserId: "user-1",
    timezone: "Europe/Paris",
  });
  const sent = calls.creates[0] as { properties: Record<string, { date: { time_zone: string | null } }> };
  assertEquals(sent.properties["Date"].date.time_zone, null);
});

Deno.test("updateTaskPage — sends title and date only, not owner", async () => {
  const { client, calls } = fakeClient({});
  const svc = createNotionService(client, { databaseId: "db-1", schema: SCHEMA });
  await svc.updateTaskPage({
    pageId: "page-1",
    title: "New title",
    dateStart: "2026-04-22",
    dateEnd: null,
    isAllDay: true,
    timezone: "Europe/Paris",
  });
  const sent = calls.updates[0] as { page_id: string; properties: Record<string, unknown> };
  assertEquals(sent.page_id, "page-1");
  assertEquals(Object.keys(sent.properties).sort(), ["Date", "Name"]);
});

Deno.test("archiveTaskPage — sends archived:true on pages.update", async () => {
  const { client, calls } = fakeClient({});
  const svc = createNotionService(client, { databaseId: "db-1", schema: SCHEMA });
  await svc.archiveTaskPage("page-1");
  assertEquals(calls.updates[0], { page_id: "page-1", archived: true });
});

Deno.test("listUsers — filters out bots, surfaces null email", async () => {
  const { client } = fakeClient({
    list: () => ({
      results: [
        { id: "u1", name: "Alice", type: "person", person: { email: "alice@co.com" } },
        { id: "u2", name: "Bot", type: "bot" },
        { id: "u3", name: "NoEmail", type: "person", person: {} },
      ],
      has_more: false,
      next_cursor: null,
    }),
  });
  const svc = createNotionService(client, { databaseId: "db-1", schema: SCHEMA });
  const users = await svc.listUsers();
  assertEquals(users, [
    { id: "u1", name: "Alice", email: "alice@co.com" },
    { id: "u3", name: "NoEmail", email: null },
  ]);
});
