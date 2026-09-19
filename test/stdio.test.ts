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
    for (const value of ["success", "failure"]) {
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
