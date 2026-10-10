import assert from "node:assert/strict";
import test from "node:test";
import { jsonBytes } from "../src/responseBudget.js";

test("response reservations count UTF-8, JSON escapes, keys and duplicate textual content", () => {
  const values = [
    null,
    true,
    false,
    -0,
    1.25,
    1e30,
    Infinity,
    'quotes"\\\b\f\n\r\t\u0001é中😀\ud800\udfff',
    {
      '"key\u0001': [null, undefined, true, { text: "é😀" }],
      omitted: undefined,
    },
    { capturedAt: new Date("2026-10-07T00:00:00.000Z") },
  ];
  for (const value of values) {
    const json = JSON.stringify(value);
    assert.equal(jsonBytes(value), Buffer.byteLength(json));
    assert.equal(
      jsonBytes(value, true),
      Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify(json)),
    );
  }
});
