import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";
import { WorkspaceError } from "../src/types.js";
import { workspace } from "../test/fixtures/workspace.js";

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const uri = "memfs:/project/example.abap";
const position = (character: number) => ({ line: 0, character });

// Synthetic provider results, as in server.test.ts. This benchmark measures the
// real MCP serialization; workspace budget enforcement has separate unit tests.
const boundedWorkspace = {
  ...workspace,
  read: async () => ({
    ...(await workspace.read({ uri })),
    text: "DATA value TYPE string. ".repeat(100).slice(0, 2048),
    requestedRange: { start: position(0), end: position(2400) },
    returnedRange: { start: position(0), end: position(2048) },
    truncated: true,
    nextPosition: position(2048),
  }),
  readSymbol: async () => ({
    ...(await boundedWorkspace.read()),
    symbol: {
      name: "example",
      kind: 5,
      range: { start: position(0), end: position(2400) },
      selectionRange: { start: position(0), end: position(7) },
    },
  }),
  search: async () => ({
    ...(await workspace.search({ uri: "memfs:/project", query: "value" })),
    filesSearched: 20,
    matches: Array.from({ length: 20 }, (_, line) => ({
      uri,
      line,
      character: 5,
      text: "DATA value TYPE string.",
      previewTruncated: false,
    })),
    truncated: true,
    nextCursor: "11111111-1111-4111-8111-111111111111",
  }),
  diagnostics: async () => ({
    ...(await workspace.diagnostics({ uri })),
    diagnostics: Array.from({ length: 10 }, (_, line) => ({
      range: { start: { line, character: 0 }, end: { line, character: 4 } },
      severity: "warning" as const,
      message: "Unused variable in this synthetic example.",
      messageTruncated: false,
    })),
    counts: { error: 0, warning: 20, information: 0, hint: 0 },
    total: 20,
    inspected: 20,
    matching: 20,
    nextOffset: 10,
    truncated: true,
  }),
  save: async () => {
    throw new WorkspaceError("VERSION_CONFLICT", "synthetic provider detail");
  },
};

export async function measureContext() {
  const server = await startServer(boundedWorkspace);
  const client = new Client({ name: "context-budget", version: "1.0.0" });
  const wire = new Map<string, Uint8Array>();
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (typeof init?.body === "string") {
            const request = JSON.parse(init.body);
            if (
              request.method === "tools/list" ||
              request.method === "tools/call"
            ) {
              assert.equal(response.status, 200);
              assert.match(
                response.headers.get("content-type") ?? "",
                /application\/json/,
              );
              const body = new Uint8Array(await response.clone().arrayBuffer());
              wire.set(
                request.method === "tools/list"
                  ? "tools/list"
                  : request.params.name,
                body,
              );
            }
          }
          return response;
        },
      }),
    );
    const discovery = await client.listTools(); // Also installs SDK output validators.
    const tools = discovery.tools.map((tool) => ({
      name: tool.name,
      definitionBytes: bytes(tool),
      inputSchemaBytes: bytes(tool.inputSchema),
      outputSchemaBytes: bytes(tool.outputSchema),
    }));
    const responses = [];
    for (const [name, args] of [
      ["read_document", { uri, maxChars: 2048 }],
      ["read_symbol", { uri, name: "example", version: 4, maxChars: 2048 }],
      [
        "search_workspace",
        { uri: "memfs:/project", query: "value", maxResults: 20 },
      ],
      ["get_diagnostics", { uri, maxResults: 10 }],
      ["save_document", { uri, version: 3 }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(
        result.isError === true,
        name === "save_document",
        `${name} returned an unexpected error state`,
      );
      const wireBytes = wire.get(name)!.byteLength;
      responses.push({
        name,
        wireBytes,
        resultBytes: bytes(result),
        structuredBytes: bytes(result.structuredContent),
        textContentBytes: bytes(result.content),
        estimatedTokensAtFourBytes: Math.ceil(wireBytes / 4),
      });
    }
    const wireBytes = wire.get("tools/list")!.byteLength;
    return {
      method:
        "Actual UTF-8 HTTP response bodies through MCP SDK; token figures are bytes/4 estimates, not tokenizer measurements.",
      toolCount: tools.length,
      discovery: {
        wireBytes,
        resultBytes: bytes(discovery),
        estimatedTokensAtFourBytes: Math.ceil(wireBytes / 4),
      },
      inputSchemaBytes: tools.reduce(
        (sum, tool) => sum + tool.inputSchemaBytes,
        0,
      ),
      outputSchemaBytes: tools.reduce(
        (sum, tool) => sum + tool.outputSchemaBytes,
        0,
      ),
      tools,
      responses,
    };
  } finally {
    try {
      await client.close();
    } finally {
      await server.close();
    }
  }
}

if (require.main === module) {
  measureContext().then(
    (report) => console.log(JSON.stringify(report, null, 2)),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
