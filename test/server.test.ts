import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type WorkspaceApi } from "../src/server.js";

const workspace: WorkspaceApi = {
  roots: () => ({ roots: [{ uri: "memfs:/project", name: "project" }] }),
  context: () => ({ activeEditor: null }),
  list: async ({ uri }) => ({ uri, entries: [] }),
  read: async ({ uri }) => ({ uri, text: "unsaved buffer", version: 4 }),
  search: async ({ query }) => ({ query, matches: [], incomplete: false }),
  edit: async ({ version }) => ({ version: version + 1, saved: false }),
  save: async () => ({ saved: false }),
  diagnostics: async () => ({ diagnostics: [] }),
};

async function http(
  url: string,
  headers: Record<string, string | undefined> = {},
  body = "{}",
  method = "POST",
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("rejects unauthenticated, browser, wrong-host and unexpected route requests before JSON parsing", async (t) => {
  const server = await startServer(workspace);
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(server.token, /^[a-f0-9]{64}$/);
  const auth = { Authorization: `Bearer ${server.token}` };
  for (const headers of [
    {},
    { Authorization: "Bearer wrong" },
    { Authorization: `Bearer ${"0".repeat(64)}` },
  ]) {
    assert.equal((await http(server.url, headers, "not JSON")).status, 401);
  }
  for (const Origin of ["https://evil.example", "null", ""]) {
    assert.equal((await http(server.url, { ...auth, Origin })).status, 403);
  }
  for (const Host of ["evil.example", "localhost", "127.0.0.1:1"]) {
    assert.equal((await http(server.url, { ...auth, Host })).status, 403);
  }
  assert.equal((await http(`${server.url}?extra=1`, auth)).status, 404);
  assert.equal((await http(server.url, auth, "", "GET")).status, 405);
  assert.equal((await http(server.url, auth, "not JSON")).status, 400);
  assert.equal(
    (await http(server.url, auth, "x".repeat(1024 * 1024 + 1))).status,
    413,
  );
});

test("official MCP client initializes, lists bounded tools and calls live-document operations", async (t) => {
  const server = await startServer(workspace);
  t.after(() => server.close());
  const client = new Client({ name: "workspace-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "edit_document",
    "editor_context",
    "get_diagnostics",
    "list_directory",
    "read_document",
    "save_document",
    "search_workspace",
    "workspace_roots",
  ]);
  const read = await client.callTool({
    name: "read_document",
    arguments: { uri: "memfs:/project/a.abap" },
  });
  assert.deepEqual(read.structuredContent, {
    result: {
      uri: "memfs:/project/a.abap",
      text: "unsaved buffer",
      version: 4,
    },
  });
  assert.equal(read.isError, undefined);
  const save = await client.callTool({
    name: "save_document",
    arguments: { uri: "memfs:/project/a.abap", version: 4 },
  });
  assert.deepEqual(save.structuredContent, { result: { saved: false } });
  for (const arguments_ of [
    { uri: "memfs:/project/a.abap", version: -1 },
    { uri: "memfs:/project/a.abap" },
    { uri: "memfs:/project/a.abap", version: 4, surprise: true },
  ]) {
    const result = await client.callTool({
      name: "save_document",
      arguments: arguments_,
    });
    assert.equal(result.isError, true);
  }
  assert.equal(
    (await client.callTool({ name: "unknown_tool", arguments: {} })).isError,
    true,
  );
});

test("provider exceptions never expose paths, stack traces or secrets over MCP", async (t) => {
  const server = await startServer({
    ...workspace,
    read: async () => {
      throw new Error("/secret/path token=private");
    },
  });
  t.after(() => server.close());
  const client = new Client({ name: "workspace-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const result = await client.callTool({
    name: "read_document",
    arguments: { uri: "memfs:/project/a.abap" },
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|server\.ts/);
});

test("limits streamed bodies even when Content-Length is absent", async (t) => {
  const server = await startServer(workspace);
  t.after(() => server.close());
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      server.url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server.token}`,
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.write("x".repeat(1024 * 1024));
    req.end("x");
  });
  assert.equal(status, 413);
});

test("rejects JSON-RPC batches so one HTTP request cannot multiply workspace operations", async (t) => {
  const server = await startServer(workspace);
  t.after(() => server.close());
  const response = await http(
    server.url,
    {
      Authorization: `Bearer ${server.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "workspace_roots", arguments: {} },
      },
    ]),
  );
  assert.equal(response.status, 400);
});

test("bounds concurrent requests and closes in-flight connections on shutdown", async (t) => {
  let entered = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = await startServer({
    ...workspace,
    read: async () => {
      entered++;
      await blocked;
      return { text: "done" };
    },
  });
  t.after(async () => {
    release();
    await server.close();
  });
  const headers = {
    Authorization: `Bearer ${server.token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_document", arguments: { uri: "memfs:/project/a" } },
  });
  const pending = Array.from({ length: 16 }, () =>
    http(server.url, headers, body).catch(() => null),
  );
  for (let retries = 0; entered < 16 && retries < 100; retries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(entered, 16);
  assert.equal((await http(server.url, headers, body)).status, 503);
  await server.close();
  assert.equal((await Promise.all(pending)).length, 16);
  await assert.rejects(http(server.url, headers));
});
