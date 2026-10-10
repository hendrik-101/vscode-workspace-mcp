import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";
import { CommandService } from "../src/commands.js";
import { workspace } from "./fixtures/workspace.js";

test("MCP command tools advertise open-world side effects, reject args and return timeout before transport expires", async (t) => {
  let calls = 0;
  let release!: () => void;
  const commands = new CommandService({
    getCommands: async () => ["fixture.run"],
    extensions: () => [
      {
        id: "fixture.one",
        packageJSON: {
          version: "1",
          contributes: {
            commands: [{ command: "fixture.run", title: "Fixture Run" }],
          },
          workspaceMcpCommandContracts: [
            {
              command: "fixture.run",
              extensionVersion: "1",
              arguments: "none",
              interaction: "none",
              context: "workspace",
              documentation: "https://example.org/fixture",
            },
          ],
        },
      },
    ],
    state: () => ({
      authorized: true,
      trusted: true,
      allowedCommands: ["fixture.run"],
      context: "workspace",
    }),
    configuration: () => undefined,
    executeCommand: () => {
      calls++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  const server = await startServer(workspace, { commands });
  const client = new Client({ name: "command-test", version: "1" });
  t.after(async () => {
    release?.();
    await client.close();
    await server.close();
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const tools = (await client.listTools()).tools;
  const invoke = tools.find((tool) => tool.name === "invoke_command");
  assert.deepEqual(invoke?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false,
  });
  assert.equal(
    tools.find((tool) => tool.name === "search_commands")?.annotations
      ?.readOnlyHint,
    true,
  );
  const search = await client.callTool({
    name: "search_commands",
    arguments: { query: "fixture" },
  });
  assert.equal(
    (search.structuredContent as any).result.commands[0].eligibility.eligible,
    true,
  );
  assert.equal(calls, 0);
  const denied = await client.callTool({
    name: "invoke_command",
    arguments: { commandId: "fixture.run", args: [] },
  });
  assert.equal(denied.isError, true);
  assert.equal(calls, 0);
  const before = Date.now();
  const reply = await client.callTool({
    name: "invoke_command",
    arguments: { commandId: "fixture.run", timeoutMs: 10 },
  });
  assert.equal(
    (reply.structuredContent as any).result.outcome,
    "completion_unconfirmed",
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - before < 5000);
});

test("failed listener startup disposes its command service", async (t) => {
  const server = await startServer(workspace);
  t.after(() => server.close());
  let disposed = 0;
  const commands = {
    search: async () => ({
      commands: [],
      truncated: false,
      incomplete: false,
      scanned: 0,
      consistency: "live" as const,
    }),
    invoke: async () => ({
      outcome: "handler_completed" as const,
      businessSuccess: "unknown" as const,
    }),
    dispose: () => {
      disposed++;
    },
  };
  await assert.rejects(
    startServer(workspace, {
      port: Number(new URL(server.url).port),
      commands,
    }),
    (error: unknown) => (error as { code: string }).code === "EADDRINUSE",
  );
  assert.equal(disposed, 1);
});
