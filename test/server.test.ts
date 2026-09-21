import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";
import { outputSchema } from "../src/contracts.js";
import { WorkspaceError, type WorkspaceApi } from "../src/types.js";

const workspace: WorkspaceApi = {
  show: async ({ uri }) => ({ uri, version: 1, dirty: false }),
  workspaceSymbols: async () => ({
    symbols: [],
    truncated: false,
    omitted: 0,
    scanned: 0,
    scanLimitReached: false,
    consistency: "live",
  }),
  definition: async () => ({
    uri: "vfs:/project/file",
    version: 1,
    dirty: false,
    locations: [],
    truncated: false,
    omitted: 0,
  }),
  references: async () => ({
    uri: "vfs:/project/file",
    version: 1,
    dirty: false,
    locations: [],
    truncated: false,
    omitted: 0,
  }),
  hover: async () => ({
    uri: "vfs:/project/file",
    version: 1,
    dirty: false,
    untrusted: true,
    hovers: [],
    truncated: false,
    omitted: 0,
  }),
  documentSymbols: async () => ({
    symbols: [],
    truncated: false,
    omitted: 0,
    scanned: 0,
    scanLimitReached: false,
    consistency: "document-version",
    version: 1,
  }),
  diff: async () => ({ shown: true }),
  format: async ({ uri, version }) => ({
    uri,
    version,
    dirty: false,
    edits: [],
    editCount: 0,
    applied: false,
  }),
  rename: async ({ uri, version }) => ({
    uri,
    version,
    dirty: false,
    providerResult: false,
    preview: {
      previewAvailable: false,
      applicationSupported: false,
      supported: false,
      applicable: false,
      complete: false,
      reasons: ["NO_EDIT"],
      documents: [],
    },
  }),
  codeActions: async ({ uri, version }) => ({
    uri,
    version,
    dirty: false,
    actions: [],
    truncated: false,
  }),
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
    requestedRange: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 14 },
    },
    returnedRange: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 14 },
    },
    truncated: false,
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
  waitForDiagnostics: async ({ uri, version }) => ({
    uri,
    diagnostics: [],
    truncated: false,
    outcome: "timeout",
    documentVersion: version,
    capturedAt: new Date().toISOString(),
    analysisComplete: "unknown",
  }),
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
  for (const name of ["show_document", "show_diff"]) {
    const annotations = tools.find((tool) => tool.name === name)?.annotations;
    assert.equal(annotations?.readOnlyHint, false);
    assert.equal(annotations?.destructiveHint, false);
  }
  assert.equal(
    tools.find((tool) => tool.name === "edit_document")?.annotations
      ?.destructiveHint,
    true,
  );
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "document_symbols",
    "edit_document",
    "editor_context",
    "format_document",
    "get_definition",
    "get_diagnostics",
    "get_hover",
    "get_references",
    "list_directory",
    "preview_code_actions",
    "preview_rename",
    "read_document",
    "save_document",
    "search_workspace",
    "show_diff",
    "show_document",
    "wait_for_diagnostics",
    "workspace_roots",
    "workspace_symbols",
  ]);
  for (const [name, args] of [
    ["workspace_roots", {}],
    ["editor_context", {}],
    ["list_directory", { uri: "memfs:/project" }],
    ["get_diagnostics", { uri: "memfs:/project/a.abap" }],
    [
      "edit_document",
      {
        uri: "memfs:/project/a.abap",
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
    ],
    ["show_document", { uri: "memfs:/project/a.abap", preserveFocus: true }],
    [
      "document_symbols",
      {
        uri: "memfs:/project/a.abap",
        version: 1,
        name: "member",
        kind: "method",
        offset: 20,
        maxResults: 20,
      },
    ],
    [
      "wait_for_diagnostics",
      { uri: "memfs:/project/a.abap", version: 4, timeoutMs: 1 },
    ],
    [
      "workspace_symbols",
      { query: "class", name: "Class", kind: 4, offset: 1, maxResults: 100 },
    ],
    [
      "get_definition",
      { uri: "memfs:/project/a.abap", position: { line: 0, character: 1 } },
    ],
    [
      "get_references",
      { uri: "memfs:/project/a.abap", position: { line: 0, character: 1 } },
    ],
    [
      "get_hover",
      { uri: "memfs:/project/a.abap", position: { line: 0, character: 1 } },
    ],
    [
      "show_diff",
      { uri: "memfs:/project/a.abap", proposedText: "", version: 4 },
    ],
    [
      "format_document",
      {
        uri: "memfs:/project/a.abap",
        version: 4,
        apply: false,
        includeEdits: true,
      },
    ],
    [
      "preview_rename",
      {
        uri: "memfs:/project/a.abap",
        version: 4,
        position: { line: 0, character: 0 },
        newName: "renamed",
      },
    ],
    [
      "preview_code_actions",
      {
        uri: "memfs:/project/a.abap",
        version: 4,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        kind: "quickfix",
      },
    ],
  ] as const) {
    assert.equal(
      (await client.callTool({ name, arguments: args })).isError,
      undefined,
    );
  }
  for (const [name, args] of [
    [
      "preview_rename",
      {
        uri: "memfs:/project/a.abap",
        version: 4,
        position: { line: 0, character: 0 },
        newName: "renamed",
        apply: true,
      },
    ],
    [
      "preview_code_actions",
      {
        uri: "memfs:/project/a.abap",
        version: 4,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        kind: "source",
      },
    ],
    ["show_document", { uri: "memfs:/project/a.abap", command: "unsafe" }],
    [
      "format_document",
      { uri: "memfs:/project/a.abap", version: 4, tabSize: 0 },
    ],
    ["workspace_symbols", { query: "" }],
    ["workspace_symbols", { query: "x", maxResults: 101 }],
    ["workspace_symbols", { query: "x", kind: "bogus" }],
    ["document_symbols", { uri: "memfs:/project/a.abap", offset: -1 }],
    [
      "wait_for_diagnostics",
      { uri: "memfs:/project/a.abap", version: 4, timeoutMs: 20001 },
    ],
    ["wait_for_diagnostics", { uri: "memfs:/project/a.abap" }],
  ] as const) {
    assert.equal(
      (await client.callTool({ name, arguments: args })).isError,
      true,
    );
  }
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
      requestedRange: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 14 },
      },
      returnedRange: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 14 },
      },
      truncated: false,
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

for (const toolName of ["edit_document", "save_document"]) {
  test(`authorization suspension permanently aborts deferred ${toolName} even after access resumes`, async (t) => {
    let release!: () => void;
    let markEntered!: () => void;
    let receivedSignal: AbortSignal | undefined;
    let mutated = false;
    let authorized = true;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const mutate = async (
      { uri, version }: { uri: string; version: number },
      signal?: AbortSignal,
    ) => {
      receivedSignal = signal;
      markEntered();
      await gate;
      signal?.throwIfAborted();
      mutated = true;
      return { uri, version, dirty: false };
    };
    const server = await startServer(
      { ...workspace, edit: mutate, save: mutate },
      { authorized: () => authorized },
    );
    t.after(async () => {
      release();
      await server.close();
    });
    const client = new Client({ name: "suspension-test", version: "1.0.0" });
    t.after(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
      }),
    );
    const pending = client.callTool({
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
    });
    await entered;
    authorized = false;
    server.abortRequests();
    assert.equal(receivedSignal?.aborted, true);
    authorized = true;
    release();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(mutated, false);
    const roots = await client.callTool({
      name: "workspace_roots",
      arguments: {},
    });
    assert.notEqual(roots.isError, true);
  });
}

test("discovery documents tool roles, URI/position conventions and search continuation", async (t) => {
  const server = await startServer(workspace);
  t.after(() => server.close());
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const { tools } = await client.listTools();
  const find = (name: string) => tools.find((tool) => tool.name === name)!;
  for (const tool of tools) {
    assert.ok(tool.outputSchema, `${tool.name} exposes its result contract`);
    const validate = new AjvJsonSchemaValidator().getValidator(
      tool.outputSchema,
    );
    assert.equal(
      validate({}).valid,
      false,
      `${tool.name} rejects an empty envelope`,
    );
    assert.equal(
      validate({ error: { code: "OPERATION_FAILED", message: "failed" } })
        .valid,
      true,
    );

    for (const [name, property] of Object.entries(
      tool.inputSchema.properties ?? {},
    )) {
      assert.ok(
        (property as { description?: string }).description,
        `${tool.name}.${name} has guidance`,
      );
      if (name === "version") {
        assert.equal(
          (property as { minimum: number }).minimum,
          1,
          `${tool.name} requires positive versions`,
        );
      }
    }
  }
  const validateRoots = new AjvJsonSchemaValidator().getValidator(
    find("workspace_roots").outputSchema!,
  );
  assert.equal(validateRoots({ result: [] }).valid, true);
  assert.equal(
    validateRoots({
      result: [],
      error: { code: "OPERATION_FAILED", message: "failed" },
    }).valid,
    false,
  );
  type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    required?: string[];
    items?: Schema;
  };
  const resultSchema = (name: string) =>
    (find(name).outputSchema as Schema).properties!.result!;
  const readSchema = resultSchema("read_document");
  for (const field of ["requestedRange", "returnedRange", "truncated"]) {
    assert.ok(readSchema.properties![field], `${field} is discoverable`);
    assert.ok(readSchema.required!.includes(field), `${field} is required`);
  }
  assert.equal(readSchema.properties!.nextPosition!.type, "object");
  assert.equal(readSchema.required!.includes("nextPosition"), false);
  const listSchema = resultSchema("list_directory");
  for (const [field, type] of [
    ["omittedEntries", "number"],
    ["incomplete", "boolean"],
    ["nextCursor", "string"],
  ]) {
    assert.equal(listSchema.properties![field!]!.type, type);
    assert.equal(listSchema.required!.includes(field!), false);
  }
  const matchSchema =
    resultSchema("search_workspace").properties!.matches!.items!;
  assert.equal(matchSchema.properties!.previewTruncated!.type, "boolean");
  assert.equal(matchSchema.required!.includes("previewTruncated"), false);
  const formatSchema = resultSchema("format_document");
  assert.equal(formatSchema.properties!.editCount!.type, "number");
  assert.ok(formatSchema.required!.includes("editCount"));
  assert.equal(formatSchema.required!.includes("edits"), false);
  for (const name of ["workspace_symbols", "document_symbols"] as const) {
    const schema = resultSchema(name);
    for (const field of [
      "version",
      "consistency",
      "nextOffset",
      "scanned",
      "scanLimitReached",
    ]) {
      assert.ok(schema.properties![field], `${name}.${field} is discoverable`);
      assert.equal(
        schema.required!.includes(field),
        name === "document_symbols" && field === "version",
      );
    }
    const validate = new AjvJsonSchemaValidator().getValidator(
      find(name).outputSchema!,
    );
    const result = { symbols: [], truncated: false, omitted: 0 };
    assert.equal(
      validate({ result }).valid,
      name === "workspace_symbols",
      "only document symbol results require version",
    );
    const withVersion = {
      result: { ...result, version: 1, futureMetadata: { available: true } },
    };
    assert.equal(validate(withVersion).valid, true);
    assert.deepEqual(outputSchema(name).parse(withVersion), withVersion);
    if (name === "document_symbols") {
      for (const version of [0, -1, 1.5]) {
        const invalid = { result: { ...result, version } };
        assert.equal(
          validate(invalid).valid,
          false,
          `version ${version} must be a positive integer`,
        );
        assert.equal(outputSchema(name).safeParse(invalid).success, false);
      }
    }
    const item = schema.properties!.symbols!.items!;
    for (const field of ["type", "selectionRange", "fullRangeKnown"]) {
      assert.ok(item.properties![field]);
      assert.equal(item.required!.includes(field), false);
    }
  }
  for (const name of ["get_diagnostics", "wait_for_diagnostics"]) {
    const schema = resultSchema(name);
    for (const field of [
      "counts",
      "total",
      "inspected",
      "matching",
      "incomplete",
      "snapshotId",
      "nextOffset",
    ]) {
      assert.ok(schema.properties![field], `${name}.${field} is discoverable`);
      assert.equal(schema.required!.includes(field), false);
    }
    assert.equal(
      schema.properties!.diagnostics!.items!.properties!.messageTruncated!.type,
      "boolean",
    );
  }
  assert.match(find("workspace_symbols").description!, /name/i);
  assert.match(find("document_symbols").description!, /outline/i);
  assert.match(find("search_workspace").description!, /literal/i);
  assert.match(find("search_workspace").description!, /nextCursor.*cursor/);
  const properties = find("get_definition").inputSchema.properties as Record<
    string,
    { description: string }
  >;
  assert.match(properties.uri!.description, /scheme/);
  assert.match(properties.position!.description, /zero-based UTF-16/i);
});

test("MCP output contracts validate success, cursor round-trips and structured errors", async (t) => {
  const cursor = "32f146a4-8c1a-4bd4-b065-7c33eaef98a7";
  let seenCursor: string | undefined;
  const server = await startServer({
    ...workspace,
    search: async (input) => {
      seenCursor = input.cursor;
      return {
        ...(await workspace.search(input)),
        nextCursor: input.cursor ? undefined : cursor,
        matches: [
          {
            uri: input.uri,
            line: 0,
            character: 0,
            text: "literal",
            previewTruncated: true,
          },
        ],
      };
    },
    context: async () => ({
      roots: [],
      tabs: [],
      truncated: false,
      activeEditor: {
        uri: "vfs:/project/file",
        version: 1,
        dirty: false,
        languageId: "text",
        selection: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        selectedText: "",
        selectionTruncated: false,
        futureMetadata: { available: true },
      },
    }),
    read: async () => {
      throw new WorkspaceError("VERSION_CONFLICT", "private provider data");
    },
    list: async (input) => ({
      ...(await workspace.list(input)),
      nextOffset: 20,
      totalEntries: 30,
      omittedEntries: 2,
      incomplete: true,
      nextCursor: cursor,
    }),
    format: async ({ uri, version }) =>
      ({ uri, version, dirty: false, applied: true, editCount: 1 }) as never,
    save: async () =>
      ({ uri: "vfs:/project/file", version: "invalid", dirty: false }) as never,
  });
  t.after(() => server.close());
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  await client.listTools(); // Populate the official client's output validators.
  const args = { uri: "vfs:/project", query: "literal", include: ["**/*.ts"] };
  const first = await client.callTool({
    name: "search_workspace",
    arguments: args,
  });
  assert.equal(
    (first.structuredContent as { result: { nextCursor: string } }).result
      .nextCursor,
    cursor,
  );
  const second = await client.callTool({
    name: "search_workspace",
    arguments: { ...args, cursor },
  });
  assert.equal(second.isError, undefined);
  assert.equal(
    (
      second.structuredContent as {
        result: { matches: Array<{ previewTruncated: boolean }> };
      }
    ).result.matches[0]!.previewTruncated,
    true,
  );
  assert.equal(seenCursor, cursor);
  const wrongKey = await client.callTool({
    name: "search_workspace",
    arguments: { ...args, nextCursor: cursor },
  });
  assert.equal(wrongKey.isError, true);
  const error = await client.callTool({
    name: "read_document",
    arguments: { uri: "vfs:/project/file" },
  });
  assert.equal(error.isError, true);
  assert.deepEqual(error.structuredContent, {
    error: {
      code: "VERSION_CONFLICT",
      message:
        "Document changed or was reopened; read its current version before retrying.",
    },
  });
  const listing = await client.callTool({
    name: "list_directory",
    arguments: { uri: "vfs:/project" },
  });
  assert.equal(
    (listing.structuredContent as { result: { nextOffset: number } }).result
      .nextOffset,
    20,
  );
  assert.deepEqual(listing.structuredContent, {
    result: {
      uri: "vfs:/project",
      entries: [],
      truncated: false,
      blockedEntries: 0,
      nextOffset: 20,
      totalEntries: 30,
      omittedEntries: 2,
      incomplete: true,
      nextCursor: cursor,
    },
  });
  const context = await client.callTool({
    name: "editor_context",
    arguments: {},
  });
  assert.deepEqual(
    (
      context.structuredContent as {
        result: { activeEditor: { futureMetadata: { available: boolean } } };
      }
    ).result.activeEditor.futureMetadata,
    { available: true },
    "nested editor metadata survives output validation",
  );
  const formatting = await client.callTool({
    name: "format_document",
    arguments: { uri: "vfs:/project/file", version: 1, apply: true },
  });
  assert.equal(formatting.isError, undefined);
  assert.equal(
    (formatting.structuredContent as { result: { editCount: number } }).result
      .editCount,
    1,
  );
  const invalid = await client.callTool({
    name: "save_document",
    arguments: { uri: "vfs:/project/file", version: 1 },
  });
  assert.equal(
    invalid.isError,
    true,
    "invalid successful output must be rejected",
  );
});

test("symbol-read contract validates bounded source and preserves additive metadata before registration", () => {
  const range = {
    start: { line: 1, character: 0 },
    end: { line: 2, character: 1 },
  };
  const result = {
    uri: "vfs:/project/file",
    version: 3,
    dirty: true,
    languageId: "abap",
    lineCount: 4,
    startLine: 1,
    endLine: 3,
    text: "source",
    requestedRange: range,
    returnedRange: range,
    truncated: false,
    symbol: {
      name: "example",
      kind: 5,
      containerName: "parent",
      range,
      selectionRange: range,
      futureMetadata: { supported: true },
    },
    futureReadMetadata: { count: 1 },
  };
  const schema = outputSchema("read_symbol");
  assert.deepEqual(schema.parse({ result }), { result });
  const { symbol: _symbol, ...missingSymbol } = result;
  assert.equal(schema.safeParse({ result: missingSymbol }).success, false);
  assert.equal(
    schema.safeParse({
      result: { ...result, symbol: { ...result.symbol, kind: "invalid" } },
    }).success,
    false,
  );
});

test("MCP rejects version zero before dispatching a version-checked operation", async (t) => {
  let called = 0;
  const server = await startServer({
    ...workspace,
    save: async (input) => {
      called++;
      return workspace.save(input);
    },
  });
  t.after(() => server.close());
  const client = new Client({ name: "version-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const zero = await client.callTool({
    name: "save_document",
    arguments: { uri: "vfs:/project/file", version: 0 },
  });
  assert.equal(zero.isError, true);
  assert.equal(called, 0);
  const one = await client.callTool({
    name: "save_document",
    arguments: { uri: "vfs:/project/file", version: 1 },
  });
  assert.equal(one.isError, undefined);
  assert.equal(called, 1);
});

test("read_document exposes exact ranges and budgets and forwards them without mutation", async (t) => {
  const calls: unknown[] = [];
  const server = await startServer({
    ...workspace,
    read: async (input) => {
      calls.push(input);
      return workspace.read(input);
    },
  });
  t.after(() => server.close());
  const client = new Client({ name: "read-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const input = {
    uri: "memfs:/project/a.abap",
    range: { start: { line: 0, character: 1 }, end: { line: 1, character: 0 } },
    version: 4,
    maxLines: 1,
    maxChars: 2,
  };
  assert.equal(
    (await client.callTool({ name: "read_document", arguments: input }))
      .isError,
    undefined,
  );
  assert.deepEqual(calls, [input]);
  for (const invalid of [
    { maxLines: 0 },
    { maxLines: 1001 },
    { maxChars: 1 },
    { maxChars: 64001 },
    { version: 0 },
    { startLine: 0 },
    { endLine: 1 },
  ]) {
    assert.equal(
      (
        await client.callTool({
          name: "read_document",
          arguments: { ...input, ...invalid },
        })
      ).isError,
      true,
    );
  }
  assert.equal(calls.length, 1);
});
