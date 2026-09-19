import assert from "node:assert/strict";
import test from "node:test";
import { clientConfiguration } from "../src/configuration";

const adapter = "C:\\VS Code\\stdio.cjs";
const url = "https://127.0.0.1:39117/mcp";
const token = 'token"quoted';
const cert = "-----BEGIN CERTIFICATE-----\npublic certificate\n";

test("Claude configuration uses stdio with credentials only in environment", () => {
  const result = JSON.parse(
    clientConfiguration("claude", adapter, url, token, cert),
  );
  assert.deepEqual(result.mcpServers.workspace_mcp, {
    type: "stdio",
    command: "node",
    args: [adapter],
    env: {
      WORKSPACE_MCP_URL: url,
      WORKSPACE_MCP_TOKEN: token,
      WORKSPACE_MCP_CERTIFICATE: cert,
    },
  });
});

test("Codex configuration safely quotes paths and multiline public certificates", () => {
  const config = clientConfiguration("codex", adapter, url, token, cert);
  assert.ok(config.includes(`args = [${JSON.stringify(adapter)}]`));
  assert.ok(config.includes(`WORKSPACE_MCP_TOKEN = ${JSON.stringify(token)}`));
  assert.ok(
    config.includes(`WORKSPACE_MCP_CERTIFICATE = ${JSON.stringify(cert)}`),
  );
  assert.ok(config.includes("[mcp_servers.workspace_mcp.env]"));
  assert.ok(!config.includes("http_headers"));
});
