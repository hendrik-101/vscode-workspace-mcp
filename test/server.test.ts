import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";
import { WorkspaceError, type WorkspaceApi } from "../src/types.js";

const workspace: WorkspaceApi = {
  roots: async () => [{ uri: "memfs:/project", name: "project", index: 0 }],
  context: async () => ({ roots: [], tabs: [], truncated: false }),
  list: async ({ uri }) => ({
    uri,
    entries: [],
    truncated: false,
    blockedEntries: 0,
  }),
  read: async ({ uri }) => ({
    uri,
    text: "unsaved buffer",
    version: 4,
    dirty: true,
    languageId: "abap",
    lineCount: 1,
    startLine: 0,
    endLine: 1,
  }),
  search: async ({ uri, query }) => ({
    uri,
    query,
    matches: [],
    filesSearched: 0,
    truncated: false,
    incomplete: false,
    errors: [],
  }),
  edit: async ({ uri, version }) => ({
    uri,
    version: version + 1,
    dirty: true,
  }),
  save: async ({ uri, version }) => ({ uri, version, dirty: false }),
  diagnostics: async ({ uri }) => ({ uri, diagnostics: [], truncated: false }),
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
      dirty: true,
      languageId: "abap",
      lineCount: 1,
      startLine: 0,
      endLine: 1,
    },
  });
  assert.equal(read.isError, undefined);
  const save = await client.callTool({
    name: "save_document",
    arguments: { uri: "memfs:/project/a.abap", version: 4 },
  });
  assert.deepEqual(save.structuredContent, {
    result: { uri: "memfs:/project/a.abap", version: 4, dirty: false },
  });
  assert.equal(
    (
      await client.callTool({
        name: "search_workspace",
        arguments: { uri: "memfs:/project", query: "text", maxResults: 100 },
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await client.callTool({
        name: "search_workspace",
        arguments: { uri: "memfs:/project", query: "text", maxResults: 101 },
      })
    ).isError,
    true,
  );
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
    read: async (input) => {
      entered++;
      await blocked;
      return workspace.read(input);
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

test("disconnected requests retain capacity only until their provider work settles", async (t) => {
  let entered = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = await startServer({
    ...workspace,
    read: async (input) => {
      entered++;
      await blocked;
      return workspace.read(input);
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
  const pending = Array.from({ length: 16 }, () => {
    const req = request(server.url, { method: "POST", headers });
    req.on("error", () => {});
    req.end(body);
    return req;
  });
  t.after(() => {
    for (const req of pending) req.destroy();
  });
  for (let retries = 0; entered < 16 && retries < 100; retries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(entered, 16);
  await Promise.all(
    pending.map(
      (req) =>
        new Promise<void>((resolve) => {
          req.once("close", resolve);
          req.destroy();
        }),
    ),
  );
  // Give the server a turn to process the disconnects before probing capacity.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await http(server.url, headers, body)).status, 503);
  assert.equal(
    entered,
    16,
    "disconnection must not admit more background work",
  );
  release();
  let response = await http(server.url, headers, body);
  for (let retries = 0; response.status === 503 && retries < 100; retries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    response = await http(server.url, headers, body);
  }
  assert.equal(
    response.status,
    200,
    "settled provider work must free the request slots",
  );
});

test("returns a safe actionable auto-save refusal", async (t) => {
  const server = await startServer({
    ...workspace,
    edit: async () => {
      throw new WorkspaceError("AUTO_SAVE_ENABLED", "private provider details");
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
    name: "edit_document",
    arguments: {
      uri: "memfs:/project/a",
      version: 4,
      edits: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          text: "x",
        },
      ],
    },
  });
  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    "AUTO_SAVE_ENABLED",
  );
  assert.match(JSON.stringify(result.content), /auto.?save/i);
  assert.doesNotMatch(JSON.stringify(result), /private provider/);
});

for (const toolName of ["edit_document", "save_document"]) {
  test(`disconnect aborts deferred ${toolName} before its mutation begins`, async (t) => {
    let release!: () => void;
    let markEntered!: () => void;
    let markSettled!: () => void;
    let mutated = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const mutate = async (
      { uri, version }: { uri: string; version: number },
      signal?: AbortSignal,
    ) => {
      markEntered();
      try {
        await gate;
        signal?.throwIfAborted();
        mutated = true;
        return { uri, version, dirty: false };
      } finally {
        markSettled();
      }
    };
    const server = await startServer({
      ...workspace,
      edit: mutate,
      save: mutate,
    });
    t.after(async () => {
      release();
      await server.close();
    });
    const req = request(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    req.on("error", () => {});
    t.after(() => req.destroy());
    req.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: {
            uri: "memfs:/project/a",
            version: 4,
            ...(toolName === "edit_document"
              ? {
                  edits: [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 },
                      },
                      text: "x",
                    },
                  ],
                }
              : {}),
          },
        },
      }),
    );
    await entered;
    await new Promise<void>((resolve) => {
      req.once("close", resolve);
      req.destroy();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await settled;
    assert.equal(mutated, false);
  });
}

test("configured endpoint reuses credentials and rejects port collisions without fallback", async () => {
  const token = "a".repeat(64);
  const first = await startServer(workspace, { token });
  const port = Number(new URL(first.url).port);
  try {
    await assert.rejects(startServer(workspace, { port, token }), {
      code: "EADDRINUSE",
    });
  } finally {
    await first.close();
  }
  const restarted = await startServer(workspace, { port, token });
  try {
    assert.equal(restarted.url, first.url);
    assert.equal(restarted.token, token);
    assert.notEqual(
      (await http(restarted.url, { Authorization: `Bearer ${token}` })).status,
      401,
    );
    assert.equal(
      (await http(restarted.url, { Authorization: `Bearer ${"b".repeat(64)}` }))
        .status,
      401,
    );
  } finally {
    await restarted.close();
  }
});

test("secret verification suspends HTTP acceptance before body parsing", async () => {
  let authorized = true;
  const server = await startServer(workspace, { authorized: () => authorized });
  try {
    const headers = { Authorization: `Bearer ${server.token}` };
    authorized = false;
    assert.equal((await http(server.url, headers, "not JSON")).status, 401);
    authorized = true;
    assert.notEqual((await http(server.url, headers)).status, 401);
  } finally {
    await server.close();
  }
});
