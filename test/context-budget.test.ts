import assert from "node:assert/strict";
import test from "node:test";
import { measureContext } from "../scripts/measure-context.js";

test("SDK wire discovery and bounded responses stay within context budgets", async () => {
  const report = await measureContext();
  assert.equal(report.toolCount, 20);
  assert.ok(report.tools.some((tool) => tool.name === "read_symbol"));
  assert.ok(report.discovery.wireBytes > report.outputSchemaBytes);
  assert.ok(
    report.discovery.wireBytes < 64_000,
    "tools/list exceeds 64 KB; inspect schema growth",
  );
  const budgets: Record<string, number> = {
    read_document: 6000,
    read_symbol: 6500,
    search_workspace: 6500,
    get_diagnostics: 5500,
    save_document: 600,
  };
  for (const response of report.responses) {
    assert.ok(response.wireBytes > response.structuredBytes);
    assert.ok(
      response.wireBytes < budgets[response.name]!,
      `${response.name} exceeds its representative response budget`,
    );
  }
  assert.equal(report.responses.length, 5);
});
