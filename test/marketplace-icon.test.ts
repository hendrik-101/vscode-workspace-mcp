import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("extension icon fits the Marketplace 1024 KiB upload limit", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const bytes = statSync(resolve(manifest.icon)).size;
  assert.ok(bytes <= 1024 * 1024, `Extension icon is ${bytes} bytes`);
});
