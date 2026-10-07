import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:https";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { startAdapter } from "../src/stdio";
import { storedIdentity } from "../src/tls";
import { startServer } from "../src/server";
import { workspace } from "./fixtures/workspace";

function identity() {
  const values = new Map<string, string>();
  return storedIdentity({
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value);
    },
  });
}

const tool = {
  name: "echo",
  description: "Echo structured data",
  inputSchema: {
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

test(
  "stdio response reservations survive upstream completion until stdout drains",
  { timeout: 20000 },
  async (t) => {
    const tls = await identity();
    const text = "\u0001".repeat(8 * 1024 * 1024);
    const bridge = await startServer(
      {
        ...workspace,
        format: async (args) => ({
          ...(await workspace.format(args)),
          editCount: 1,
          edits: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              text,
            },
          ],
        }),
      },
      { tls },
    );
    t.after(() => bridge.close());
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const adapter = await startAdapter({
      url: bridge.url,
      token: bridge.token,
      certificate: tls.cert,
      input: incoming,
      output: outgoing,
    });
    t.after(() => adapter.close());
    const client = new Client({ name: "slow-preview-test", version: "1" });
    await client.connect(
      new StdioServerTransport(outgoing, incoming, {
        maxBufferSize: 128 * 1024 * 1024,
      }),
    );
    t.after(() => client.close());
    outgoing.pause();
    const waitForOutput = async (previous: number) => {
      const deadline = Date.now() + 5000;
      while (outgoing.writableLength <= previous && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(
        outgoing.writableLength > previous,
        "response reached the blocked stdout writer",
      );
    };
    const call = () =>
      client.callTool({
        name: "format_document",
        arguments: { uri: "memfs:/project/a", version: 1 },
      });
    const first = call();
    await waitForOutput(0);
    const previous = outgoing.writableLength;
    const second = call();
    await waitForOutput(previous);
    const beforeThird = outgoing.writableLength;
    const third = call();
    await waitForOutput(beforeThird);
    outgoing.resume();
    const [one, two, refused] = await Promise.all([first, second, third]);
    assert.notEqual(one.isError, true);
    assert.notEqual(two.isError, true);
    assert.equal(refused.isError, true);
    const error = refused.structuredContent as {
      error: { code: string; message: string };
    };
    assert.equal(error.error.code, "LIMIT_EXCEEDED");
    assert.match(error.error.message, /256 MiB/);
    assert.notEqual((await call()).isError, true);
  },
);

test("large full formatting previews cross stdio when the client receive buffer is configured", async (t) => {
  const tls = await identity();
  const replacement = "x".repeat(8 * 1024 * 1024);
  const bridge = await startServer(
    {
      ...workspace,
      format: async ({ uri, version }) => ({
        uri,
        version,
        dirty: false,
        applied: false,
        editCount: 1,
        edits: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            text: replacement,
          },
        ],
      }),
    },
    { tls },
  );
  t.after(() => bridge.close());
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const adapter = await startAdapter({
    url: bridge.url,
    token: bridge.token,
    certificate: tls.cert,
    input: incoming,
    output: outgoing,
  });
  t.after(() => adapter.close());
  const client = new Client({ name: "large-preview-test", version: "1" });
  await client.connect(
    new StdioServerTransport(outgoing, incoming, {
      maxBufferSize: 128 * 1024 * 1024,
    }),
  );
  t.after(() => client.close());
  const result = await client.callTool({
    name: "format_document",
    arguments: { uri: "memfs:/project/a.abap", version: 1 },
  });
  assert.notEqual(result.isError, true);
  const data = result.structuredContent as {
    result: { edits: Array<{ text: string }> };
  };
  assert.equal(data.result.edits[0]!.text, replacement);
  assert.ok(JSON.stringify(result).length > 16 * 1024 * 1024);
});

test(
  "stdio preserves tool schemas, results, errors and cancellation through trusted TLS",
  { timeout: 10000 },
  async (t) => {
    const tls = await identity();
    let entered!: () => void;
    let cancelled!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const requestCancelled = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let authorizations = 0;
    const https = createServer(tls, async (req, res) => {
      if (req.headers.authorization === "Bearer private-test-token")
        authorizations++;
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const upstream = new Server(
        { name: "fixture", version: "1" },
        { capabilities: { tools: {} } },
      );
      upstream.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [tool],
      }));
      upstream.setRequestHandler(
        CallToolRequestSchema,
        async (request, extra) => {
          if (request.params.arguments?.value === "wait") {
            entered();
            await new Promise<void>((resolve) => {
              if (extra.signal.aborted) resolve();
              else
                extra.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            cancelled();
          }
          if (request.params.arguments?.value === "throw")
            throw new Error("private-test-token raw sensitive exception");
          return {
            content: [{ type: "text", text: "response" }],
            structuredContent: { value: request.params.arguments?.value },
            isError: request.params.arguments?.value === "failure",
          };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void upstream.close();
      });
      await upstream.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          https.closeAllConnections();
          https.close(() => resolve());
        }),
    );
    const address = https.address();
    assert.ok(address && typeof address !== "string");
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const adapter = await startAdapter({
      url: `https://127.0.0.1:${address.port}/mcp`,
      token: "private-test-token",
      certificate: tls.cert,
      input: incoming,
      output: outgoing,
    });
    t.after(() => adapter.close());
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioServerTransport(outgoing, incoming));
    t.after(() => client.close());
    assert.deepEqual((await client.listTools()).tools, [tool]);
    for (const value of ["success", "failure", "x".repeat(1_100_000)]) {
      const result = await client.callTool({
        name: "echo",
        arguments: { value },
      });
      assert.deepEqual(result.structuredContent, { value });
      assert.equal(result.isError, value === "failure");
    }
    await assert.rejects(
      client.callTool({ name: "echo", arguments: { value: "throw" } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes("Workspace MCP request failed"));
        assert.ok(!error.message.includes("private-test-token"));
        assert.ok(!error.message.includes("raw sensitive"));
        return true;
      },
    );
    const abort = new AbortController();
    const pending = client.callTool(
      { name: "echo", arguments: { value: "wait" } },
      undefined,
      { signal: abort.signal },
    );
    const rejected = assert.rejects(pending);
    await requestEntered;
    abort.abort();
    await rejected;
    await requestCancelled;
    assert.ok(authorizations > 0);
  },
);

test("a server on the expected port without the trusted certificate receives no bearer token", async (t) => {
  const trusted = await identity();
  const impostor = await identity();
  let requests = 0;
  const https = createServer(impostor, (_req, res) => {
    requests++;
    res.end();
  });
  await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        https.closeAllConnections();
        https.close(() => resolve());
      }),
  );
  const address = https.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(
    startAdapter({
      url: `https://127.0.0.1:${address.port}/mcp`,
      token: "never-disclose-this",
      certificate: trusted.cert,
    }),
    {
      message:
        "Workspace MCP connection failed. Start the bridge and refresh its connection details.",
    },
  );
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/stdio-main.ts"],
      {
        env: {
          ...process.env,
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          WORKSPACE_MCP_URL: `https://127.0.0.1:${address.port}/mcp`,
          WORKSPACE_MCP_TOKEN: "never-disclose-this",
          WORKSPACE_MCP_CERTIFICATE: trusted.cert,
        },
        timeout: 10000,
      },
    ),
    (error: unknown) => {
      const failure = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      assert.ok(
        failure.stderr.includes("Workspace MCP adapter could not connect"),
      );
      assert.ok(!failure.stderr.includes("never-disclose-this"));
      return true;
    },
  );
  assert.equal(requests, 0);
});

test("adapter refuses non-loopback, insecure and ambiguous destinations", async () => {
  for (const url of [
    "http://127.0.0.1:39117/mcp",
    "https://example.com:39117/mcp",
    "https://user@127.0.0.1:39117/mcp",
    "https://127.0.0.1:39117/mcp?query",
    "https://127.0.0.1:39117/mcp#fragment",
  ]) {
    await assert.rejects(
      startAdapter({ url, token: "token", certificate: "certificate" }),
    );
  }
});

test("trusted endpoints cannot redirect the adapter to another destination", async (t) => {
  const tls = await identity();
  let unexpected = 0;
  const https = createServer(tls, (req, res) => {
    if (req.url !== "/mcp") unexpected++;
    res.writeHead(307, { Location: "/steal-token" }).end();
  });
  await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        https.closeAllConnections();
        https.close(() => resolve());
      }),
  );
  const address = https.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(
    startAdapter({
      url: `https://127.0.0.1:${address.port}/mcp`,
      token: "private-token",
      certificate: tls.cert,
    }),
  );
  assert.equal(unexpected, 0);
});
