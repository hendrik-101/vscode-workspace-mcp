import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable, Writable } from "node:stream";
import {
  Agent,
  fetch as fetchWithDispatcher,
  type RequestInit as DispatcherRequestInit,
} from "undici";

export interface AdapterOptions {
  url: string;
  token: string;
  certificate: string;
  input?: Readable;
  output?: Writable;
}

/** Start the tools-only stdio adapter, trusting only the configured local bridge. */
export async function startAdapter(options: AdapterOptions) {
  const endpoint = new URL(options.url);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/mcp" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    !options.token ||
    /[\r\n]/.test(options.token) ||
    !options.certificate
  ) {
    throw new Error("Invalid Workspace MCP adapter configuration.");
  }
  const dispatcher = new Agent({
    connect: { ca: options.certificate, rejectUnauthorized: true },
  });
  const upstream = new Client({
    name: "workspace-mcp-stdio",
    version: "0.1.0",
  });
  const server = new Server(
    { name: "workspace-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  // The HTTP SDK otherwise cancels only the protocol request. Abort its actual
  // HTTP fetch too, so the stateless bridge can revoke an in-flight operation.
  const requestSignal = new AsyncLocalStorage<AbortSignal>();
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` } },
    fetch: async (input, init) => {
      const requested = String(input);
      if (requested !== endpoint.href) {
        throw new Error("Workspace MCP destination rejected.");
      }
      const signal = requestSignal.getStore();
      // MCP sends JSON strings. Narrow the body rather than casting between
      // browser and Node fetch request types (whose FormData types differ).
      if (init?.body != null && typeof init.body !== "string") {
        throw new Error("Workspace MCP request body rejected.");
      }
      const request: DispatcherRequestInit = {
        ...init,
        body: init?.body,
        headers: [...new Headers(init?.headers).entries()],
        dispatcher,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
          : init?.signal,
      };
      const response = await fetchWithDispatcher(input, request);
      // Undici returns a standard Fetch Response; its Node stream declarations
      // differ from the DOM declarations required by the SDK's FetchLike type.
      return response as unknown as Response;
    },
  });
  const input = options.input ?? process.stdin;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    input.off("end", ended);
    input.off("error", ended);
    await Promise.allSettled([server.close(), upstream.close()]);
    await dispatcher.destroy();
  };
  const ended = () => {
    void close();
  };
  const unavailable = () =>
    new McpError(
      ErrorCode.InternalError,
      "Workspace MCP request failed. Check the bridge connection and permissions.",
    );
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    try {
      return await requestSignal.run(extra.signal, () =>
        upstream.listTools(request.params, { signal: extra.signal }),
      );
    } catch {
      throw unavailable();
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await requestSignal.run(extra.signal, () =>
        upstream.callTool(request.params, undefined, {
          signal: extra.signal,
        }),
      );
    } catch {
      throw unavailable();
    }
  });
  server.onclose = ended;
  server.onerror = () => {};
  upstream.onerror = () => {};
  try {
    await upstream.connect(transport);
    await server.connect(
      new StdioServerTransport(input, options.output ?? process.stdout, {
        maxBufferSize: 1024 * 1024,
      }),
    );
    input.once("end", ended);
    input.once("error", ended);
    return { close };
  } catch {
    await close();
    throw new Error(
      "Workspace MCP connection failed. Start the bridge and refresh its connection details.",
    );
  }
}
