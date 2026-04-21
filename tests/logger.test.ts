import { assertEquals, assertMatch } from "jsr:@std/assert@^1";
import { formatLine } from "../logger.ts";

Deno.test("formatLine — no fields", () => {
  const line = formatLine("2026-04-21T09:00:00.000Z", "info", "run_start");
  assertEquals(line, "[2026-04-21T09:00:00.000Z] [info] run_start");
});

Deno.test("formatLine — simple key=value fields", () => {
  const line = formatLine("2026-04-21T09:00:00.000Z", "info", "n2g_event_created", {
    page: "abc123",
    user: "alice@co.com",
  });
  assertEquals(
    line,
    `[2026-04-21T09:00:00.000Z] [info] n2g_event_created page=abc123 user=alice@co.com`,
  );
});

Deno.test("formatLine — quotes values containing whitespace", () => {
  const line = formatLine("2026-04-21T09:00:00.000Z", "info", "n2g_event_created", {
    title: "Call client",
  });
  assertMatch(line, /title="Call client"/);
});

Deno.test("formatLine — escapes embedded double quotes", () => {
  const line = formatLine("2026-04-21T09:00:00.000Z", "warn", "note", {
    title: 'Say "hello"',
  });
  assertMatch(line, /title="Say \\"hello\\""/);
});

Deno.test("formatLine — renders null and undefined as null", () => {
  const line = formatLine("2026-04-21T09:00:00.000Z", "debug", "evt", {
    a: null,
    b: undefined,
  });
  assertMatch(line, /a=null b=null/);
});

Deno.test("formatLine — renders numbers and booleans unquoted", () => {
  const line = formatLine("2026-04-21T09:00:00.000Z", "info", "stats", {
    count: 3,
    ok: true,
  });
  assertMatch(line, /count=3 ok=true/);
});
