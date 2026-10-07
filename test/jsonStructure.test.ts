import assert from "node:assert/strict";
import test from "node:test";
import { JsonStructureGuard } from "../src/jsonStructure.js";
import { MAX_JSON_DEPTH, MAX_JSON_TOKENS } from "../src/limits.js";

test("JSON guard preserves quoted structural characters and escapes across chunks", () => {
  const text = 'é😀\\"{},[]\n'.repeat(20_000);
  const body = Buffer.from(JSON.stringify({ text, values: [1, true, null] }));
  const guard = new JsonStructureGuard();
  // Single-byte chunks exercise escapes and multibyte UTF-8 at every boundary.
  for (let i = 0; i < body.length; i++) guard.push(body.subarray(i, i + 1));
});

test("JSON guard bounds containers, property names and primitive values", () => {
  for (const entry of ["{}", '"key":0', "null"]) {
    const object = entry.includes(":");
    const perEntry = object ? 2 : 1;
    const count = Math.floor((MAX_JSON_TOKENS - 1) / perEntry);
    const guard = new JsonStructureGuard();
    guard.push(
      Buffer.from((object ? "{" : "[") + `${entry},`.repeat(count - 1) + entry),
    );
    assert.throws(
      () => guard.push(Buffer.from(`,${entry}`)),
      /250000 token limit/,
    );
  }
});

test("JSON guard checks nesting before parsing", () => {
  const guard = new JsonStructureGuard();
  guard.push(Buffer.from("[".repeat(MAX_JSON_DEPTH)));
  assert.throws(() => guard.push(Buffer.from("[")), /64 level limit/);
});

test("only stdio frame boundaries reset the structural budget", () => {
  const frame = "[" + "{},".repeat(150_000) + "{}]";
  const stdio = new JsonStructureGuard(true);
  stdio.push(Buffer.from(frame + "\n" + frame + "\n"));
  const http = new JsonStructureGuard();
  http.push(Buffer.from("[" + "{},\n".repeat(150_000)));
  assert.throws(
    () => http.push(Buffer.from("{},\n".repeat(150_000) + "{}]")),
    /250000 token limit/,
  );
});
