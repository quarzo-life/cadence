import { assertEquals } from "jsr:@std/assert@^1";
import { parseMode } from "../main.ts";

Deno.test("parseMode — no args defaults to incremental", () => {
  assertEquals(parseMode([]), "incremental");
});

Deno.test("parseMode — explicit incremental", () => {
  assertEquals(parseMode(["incremental"]), "incremental");
});

Deno.test("parseMode — reconcile", () => {
  assertEquals(parseMode(["reconcile"]), "reconcile");
});

Deno.test("parseMode — case-insensitive", () => {
  assertEquals(parseMode(["Reconcile"]), "reconcile");
  assertEquals(parseMode(["INCREMENTAL"]), "incremental");
});

Deno.test("parseMode — unknown mode → null", () => {
  assertEquals(parseMode(["bogus"]), null);
  assertEquals(parseMode(["--help"]), null);
});

Deno.test("parseMode — extra args are ignored after the mode", () => {
  assertEquals(parseMode(["reconcile", "--verbose"]), "reconcile");
});
