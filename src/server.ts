import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { WorkspaceApi } from "./types.js";

const MAX_BODY = 1024 * 1024;
const MAX_REQUESTS = 16;
const REQUEST_TIMEOUT = 30_000;
const uri = z.string().min(1).max(8192);
const index = z.number().int().min(0).max(2_147_483_647);
const position = z.strictObject({ line: index, character: index });
const errors: Record<string, string> = {
  INVALID_ARGUMENT: "Invalid workspace operation arguments.",
  OUTSIDE_WORKSPACE: "Resource is outside the admitted workspace roots.",
  SYMLINK_DENIED: "Symbolic links are not admitted.",
  WRITES_DISABLED: "Writes require explicit approval for this session.",
  UNTRUSTED_WORKSPACE: "Workspace Trust is required.",
  AUTO_SAVE_ENABLED:
    "Disable editor auto-save before applying buffer-only edits.",
  VERSION_CONFLICT:
    "Document changed; read its current version before writing.",
  LIMIT_EXCEEDED: "Workspace operation exceeded its limit.",
  NOT_A_FILE: "Resource is not a file.",
  NOT_A_DIRECTORY: "Resource is not a directory.",
  EDIT_FAILED: "The editor refused the edit.",
  SAVE_FAILED: "The editor refused to save the document.",
};

function createMcpServer(
  workspace: WorkspaceApi,
  execute: (operation: () => unknown) => Promise<unknown>,
) {
  const server = new McpServer({
    name: "vscode-workspace-mcp",
    version: "0.1.0",
  });
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: z.ZodObject<S>,
    operation: (args: z.output<typeof schema>) => unknown,
    readOnly = true,
  ) {
    server.registerTool<z.ZodRawShape, z.ZodObject<S>>(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          const result = await execute(() =>
            operation(args as z.output<typeof schema>),
          );
          const structuredContent = { result };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(structuredContent),
              },
            ],
            structuredContent,
          };
        } catch (error) {
          const code =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof error.code === "string" &&
            Object.hasOwn(errors, error.code)
              ? error.code
              : "OPERATION_FAILED";
          const structuredContent = {
            error: {
              code,
              message: errors[code] ?? "Workspace operation failed.",
            },
          };
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(structuredContent),
              },
            ],
            structuredContent,
          };
        }
      },
    );
  }
  tool(
    "workspace_roots",
    "List the current admitted workspace roots as full URIs.",
    z.strictObject({}),
    () => workspace.roots(),
  );
  tool(
    "editor_context",
    "Get active editor and selections within admitted workspace roots.",
    z.strictObject({}),
    () => workspace.context(),
  );
  tool(
    "list_directory",
    "List a workspace directory using its URI.",
    z.strictObject({ uri }),
    (args) => workspace.list(args),
  );
  tool(
    "read_document",
    "Read live document text and version. Lines are zero-based; endLine is exclusive.",
    z.strictObject({
      uri,
      startLine: index.optional(),
      endLine: index.optional(),
    }),
    (args) => workspace.read(args),
  );
  tool(
    "search_workspace",
    "Search literal text within a workspace URI. Results report incomplete searches.",
    z.strictObject({
      uri,
      query: z.string().min(1).max(4096),
      maxResults: z.number().int().min(1).max(100).optional(),
    }),
    (args) => workspace.search(args),
  );
  tool(
    "edit_document",
    "Apply version-checked edits to the live buffer without saving. Requires session write approval and Workspace Trust.",
    z.strictObject({
      uri,
      version: index,
      edits: z
        .array(
          z.strictObject({
            range: z.strictObject({ start: position, end: position }),
            text: z.string().max(MAX_BODY),
          }),
        )
        .min(1)
        .max(100),
    }),
    (args) => workspace.edit(args),
    false,
  );
  tool(
    "save_document",
    "Explicitly save a version-checked document. May invoke provider save hooks. Requires approved writes and Workspace Trust.",
    z.strictObject({ uri, version: index }),
    (args) => workspace.save(args),
    false,
  );
  tool(
    "get_diagnostics",
    "Get editor diagnostics for a workspace document.",
    z.strictObject({ uri }),
    (args) => workspace.diagnostics(args),
  );
  return server;
}

function reject(response: ServerResponse, status: number, message: string) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    Connection: "close",
    "Cache-Control": "no-store",
  });
  response.end(message);
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: RequestError) => {
      cleanup();
      request.pause();
      rejectBody(error);
    };
    const onError = () => fail(new RequestError(400, "Request failed."));
    const onAborted = () => fail(new RequestError(400, "Request aborted."));
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY)
        fail(new RequestError(413, "Request body too large."));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(new RequestError(400, "Invalid JSON."));
      }
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

export async function startServer(
  workspace: WorkspaceApi,
  options: { port?: number } = {},
): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const connections = new Set<Socket>();
  const sessions = new Set<McpServer>();
  let host = "";
  let active = 0;
  let closed = false;
  const httpServer = createServer(
    { maxHeaderSize: 8192 },
    (request, response) => {
      void handle(request, response).catch(() =>
        reject(response, 500, "Request failed."),
      );
    },
  );
  httpServer.maxConnections = 64;
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.setTimeout(REQUEST_TIMEOUT, (socket) => socket.destroy());
  httpServer.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    // Reject browser traffic and DNS rebinding before reading a single body byte.
    const hostCount = request.rawHeaders.filter(
      (value, i) => i % 2 === 0 && value.toLowerCase() === "host",
    ).length;
    if (
      hostCount !== 1 ||
      request.headers.host !== host ||
      request.headers.origin !== undefined
    )
      return reject(response, 403, "Forbidden.");
    const authorization = Buffer.from(request.headers.authorization ?? "");
    const authCount = request.rawHeaders.filter(
      (value, i) => i % 2 === 0 && value.toLowerCase() === "authorization",
    ).length;
    if (
      authCount !== 1 ||
      authorization.length !== expectedAuthorization.length ||
      !timingSafeEqual(authorization, expectedAuthorization)
    )
      return reject(response, 401, "Unauthorized.");
    if (request.url !== "/mcp") return reject(response, 404, "Not found.");
    if (request.method !== "POST")
      return reject(response, 405, "Method not allowed.");
    if (closed || active >= MAX_REQUESTS)
      return reject(response, 503, "Server busy.");
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY)
      return reject(response, 413, "Request body too large.");
    active++;
    let mcp: McpServer | undefined;
    let finished = false;
    let running = 0;
    let released = false;
    const release = () => {
      if (finished && running === 0 && !released) {
        released = true;
        active--;
      }
    };
    const execute = async (operation: () => unknown) => {
      if (finished) throw new RequestError(408, "Request ended.");
      running++;
      try {
        return await operation();
      } finally {
        running--;
        release();
      }
    };
    const timeout = setTimeout(() => {
      reject(response, 408, "Request timed out.");
      request.destroy();
    }, REQUEST_TIMEOUT);
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      // A disconnected client cannot release capacity while provider work runs.
      release();
      if (mcp) {
        sessions.delete(mcp);
        void mcp.close().catch(() => {});
      }
    };
    const disconnected = new Promise<void>((resolve) => {
      response.once("close", () => {
        cleanup();
        resolve();
      });
    });
    try {
      const body = await readBody(request);
      if (response.destroyed || closed) return;
      if (Array.isArray(body))
        return reject(response, 400, "Batch requests are not supported.");
      mcp = createMcpServer(workspace, execute);
      sessions.add(mcp);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      response.setHeader("Cache-Control", "no-store");
      // The SDK's JSON-response promise can remain pending after transport.close().
      await Promise.race([
        transport.handleRequest(request, response, body),
        disconnected,
      ]);
    } catch (error) {
      reject(
        response,
        error instanceof RequestError ? error.status : 500,
        error instanceof RequestError ? error.message : "Request failed.",
      );
    } finally {
      cleanup();
    }
  }

  await new Promise<void>((resolve, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(options.port ?? 0, "127.0.0.1", () => {
      httpServer.off("error", rejectListen);
      const address = httpServer.address();
      if (!address || typeof address === "string")
        return rejectListen(new Error("Invalid listener address."));
      host = `127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return {
    url: `http://${host}/mcp`,
    token,
    async close() {
      if (closed) return;
      closed = true;
      const closing = new Promise<void>((resolve) =>
        httpServer.close(() => resolve()),
      );
      for (const socket of connections) socket.destroy();
      await Promise.allSettled([...sessions].map((session) => session.close()));
      await closing;
    },
  };
}
