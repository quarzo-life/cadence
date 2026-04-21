import { assertEquals } from "jsr:@std/assert@^1";
import { matchKeyword } from "../sync-g2n.ts";

Deno.test("matchKeyword — colon separator", () => {
  assertEquals(matchKeyword("NOTION", "NOTION: Call client"), "Call client");
});

Deno.test("matchKeyword — whitespace separator", () => {
  assertEquals(matchKeyword("NOTION", "NOTION Call client"), "Call client");
});

Deno.test("matchKeyword — case insensitive, dash separator", () => {
  assertEquals(matchKeyword("NOTION", "notion - bla"), "bla");
});

Deno.test("matchKeyword — en dash separator", () => {
  assertEquals(matchKeyword("NOTION", "NOTION – bar"), "bar");
});

Deno.test("matchKeyword — em dash separator", () => {
  assertEquals(matchKeyword("NOTION", "NOTION — foo"), "foo");
});

Deno.test("matchKeyword — leading/trailing whitespace around keyword and body", () => {
  assertEquals(matchKeyword("NOTION", "  NOTION  :  padded  "), "padded");
});

Deno.test("matchKeyword — no match when keyword continues into another word", () => {
  assertEquals(matchKeyword("NOTION", "NOTIONEVENT: x"), null);
});

Deno.test("matchKeyword — no match when keyword is not at the start", () => {
  assertEquals(matchKeyword("NOTION", "Weekly NOTION meeting"), null);
});

Deno.test("matchKeyword — keyword alone is not a match", () => {
  assertEquals(matchKeyword("NOTION", "NOTION"), null);
});

Deno.test("matchKeyword — keyword + separator without body is not a match", () => {
  assertEquals(matchKeyword("NOTION", "NOTION:"), null);
  assertEquals(matchKeyword("NOTION", "NOTION: "), null);
});

Deno.test("matchKeyword — undefined and empty return null", () => {
  assertEquals(matchKeyword("NOTION", undefined), null);
  assertEquals(matchKeyword("NOTION", ""), null);
  assertEquals(matchKeyword("NOTION", "   "), null);
});

Deno.test("matchKeyword — custom keyword with regex metacharacters is escaped", () => {
  assertEquals(matchKeyword("N.OTE", "N.OTE: body"), "body");
  assertEquals(matchKeyword("N.OTE", "NxOTE: body"), null);
});

Deno.test("matchKeyword — trims the extracted body", () => {
  assertEquals(matchKeyword("NOTION", "NOTION: Call client   "), "Call client");
});
