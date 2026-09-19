import assert from "node:assert/strict";
import test from "node:test";
import { clientConfiguration } from "../src/configuration";

test("Claude configuration preserves URL and token without a shell command", () => {
  const result = JSON.parse(
    clientConfiguration("claude", "http://127.0.0.1:4567/mcp", "test-token"),
  );
  assert.deepEqual(result.mcpServers.workspace_mcp, {
    type: "http",
    url: "http://127.0.0.1:4567/mcp",
    headers: { Authorization: "Bearer test-token" },
  });
});

test("Codex configuration uses its HTTP transport and safely quotes credentials", () => {
  const config = clientConfiguration(
    "codex",
    "http://127.0.0.1:4567/mcp",
    'token"quoted',
  );
  assert.match(config, /\[mcp_servers.workspace_mcp\]/);
  assert.match(
    config,
    /http_headers = \{ Authorization = "Bearer token\\"quoted" \}/,
  );
  assert.ok(!config.includes("command ="));
});
