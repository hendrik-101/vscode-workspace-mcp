import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  MAX_REQUEST_BYTES,
  MAX_IN_FLIGHT_REQUEST_BYTES,
  MemoryLimitError,
} from "./limits";
import { ResponseBudget, jsonBytes } from "./responseBudget";
import { JsonStructureError, JsonStructureGuard } from "./jsonStructure";
import { Transform, type Readable, type Writable } from "node:stream";
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
  onInputError?: (message: string) => void;
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
  const structure = new JsonStructureGuard(true);
  const guardedInput = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        structure.push(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    input.off("end", ended);
    input.off("error", ended);
    input.unpipe(guardedInput);
    guardedInput.destroy();
    if (input.listenerCount("data") === 0) input.pause();
    await Promise.allSettled([server.close(), upstream.close()]);
    await dispatcher.destroy();
  };
  const ended = () => {
    void close();
  };
  guardedInput.on("error", (error: Error) => {
    try {
      options.onInputError?.(
        error instanceof JsonStructureError
          ? error.message
          : "Workspace MCP adapter input failed. Restart the adapter and retry a smaller operation.",
      );
    } finally {
      void close();
    }
  });
  const unavailable = () =>
    new McpError(
      ErrorCode.InternalError,
      "Workspace MCP request failed. Check the bridge connection and permissions.",
    );
  let requestBytes = 0;
  type Reservation = {
    id: string | number;
    bytes: number;
    phase: "queued" | "running" | "settled" | "reply";
  };
  const requestContext = new AsyncLocalStorage<Reservation | undefined>();
  const requests = new Map<string | number, Reservation>();
  const refusedIds = new Set<string | number>();
  const releaseRequest = (reservation: Reservation | undefined) => {
    if (!reservation || requests.get(reservation.id) !== reservation) return;
    requestBytes -= reservation.bytes;
    requests.delete(reservation.id);
  };
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const reservation = requestContext.getStore();
    if (reservation) reservation.phase = "running";
    try {
      extra.signal.throwIfAborted();
      return await requestSignal.run(extra.signal, () =>
        upstream.listTools(request.params, { signal: extra.signal }),
      );
    } catch {
      throw unavailable();
    } finally {
      // Cancelled handlers produce no protocol reply. Normal requests remain
      // retained by the SDK until their response finishes writing.
      if (reservation) reservation.phase = "settled";
      if (extra.signal.aborted) releaseRequest(reservation);
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const reservation = requestContext.getStore();
    if (reservation) reservation.phase = "running";
    try {
      extra.signal.throwIfAborted();
      return await requestSignal.run(extra.signal, () =>
        upstream.callTool(request.params, undefined, {
          signal: extra.signal,
        }),
      );
    } catch {
      throw unavailable();
    } finally {
      if (reservation) reservation.phase = "settled";
      if (extra.signal.aborted) releaseRequest(reservation);
    }
  });
  server.onclose = ended;
  server.onerror = () => {};
  upstream.onerror = () => {};
  const stdio = new StdioServerTransport(
    guardedInput,
    options.output ?? process.stdout,
    {
      maxBufferSize: MAX_REQUEST_BYTES,
    },
  );
  const responseBudget = new ResponseBudget();
  const send = stdio.send.bind(stdio);
  stdio.send = async (message) => {
    const context = requestContext.getStore();
    const reservation =
      "id" in message && !("method" in message) && message.id === context?.id
        ? context
        : undefined;
    if (reservation) reservation.phase = "reply";
    let release: (() => void) | undefined;
    try {
      release = responseBudget.reserve(jsonBytes(message) + 1);
    } catch (error) {
      if (!(error instanceof MemoryLimitError)) {
        releaseRequest(reservation);
        await close();
        throw unavailable();
      }
      if (!("result" in message) || !("content" in message.result)) {
        await close();
        throw unavailable();
      }
      const structuredContent = {
        error: {
          code: error.code,
          message: MemoryLimitError.describe(
            error.budget,
            error.requestedBytes,
          ),
        },
      };
      message = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          structuredContent,
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        },
      };
      // Even a refusal retains its caller-supplied id until stdout drains.
      // Fail closed if the compact error cannot fit the remaining budget.
      try {
        release = responseBudget.reserve(jsonBytes(message) + 1);
      } catch {
        await close();
        throw unavailable();
      }
    }
    try {
      await send(message);
    } finally {
      release?.();
      releaseRequest(reservation);
    }
  };
  // Keep only the refusal ID/message alive through backpressure, not the
  // rejected frame (which may exceed the remaining admitted-byte budget).
  const refuse = async (id: string | number, message: string) => {
    // Serialized-byte limits alone do not bound promises/listeners for many
    // small errors. Stop input once this separate refusal queue is full.
    if (refusedIds.size >= 16) {
      await close();
      return;
    }
    refusedIds.add(id);
    try {
      await stdio.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: ErrorCode.InternalError,
          message,
          data: { code: "LIMIT_EXCEEDED" },
        },
      });
    } catch {
      await close();
    } finally {
      refusedIds.delete(id);
    }
  };
  const start = stdio.start.bind(stdio);
  stdio.start = async () => {
    // Install before the SDK attaches its input listener. Admit the complete
    // parsed frame, including fields/id that a tool schema may later strip,
    // before the protocol queues a handler or reserializes the HTTP request.
    const dispatch = stdio.onmessage;
    stdio.onmessage = (message) => {
      if (closed) return;
      if ("method" in message && "id" in message) {
        // Reusing a live id makes replies/cancellation ambiguous; fail closed
        // rather than allowing a refusal to release the original reservation.
        if (requests.has(message.id) || refusedIds.has(message.id)) {
          void close();
          return;
        }
        let refusal: string | undefined;
        let reservation: Reservation | undefined;
        if (requests.size >= 16) {
          refusal =
            "Request count limit is 16 unfinished stdio adapter requests. Wait for earlier requests and responses to finish, then retry.";
        } else {
          try {
            const bytes = jsonBytes(message);
            if (requestBytes + bytes > MAX_IN_FLIGHT_REQUEST_BYTES) {
              refusal = MemoryLimitError.describe(
                "adapterRequestsInFlight",
                requestBytes + bytes,
              );
            } else {
              reservation = { id: message.id, bytes, phase: "queued" };
              requests.set(message.id, reservation);
              requestBytes += bytes;
            }
          } catch {
            refusal =
              "Request data cannot be encoded within adapter limits. Send a smaller or less deeply nested operation.";
          }
        }
        if (refusal) {
          // Refusals own no admitted request bytes, but their IDs stay active
          // until the compact error drains, just like admitted response IDs.
          void requestContext.run(undefined, refuse, message.id, refusal);
          return;
        }
        requestContext.run(reservation, () => dispatch?.(message));
        return;
      }
      const cancelled = CancelledNotificationSchema.safeParse(message);
      const reservation =
        cancelled.success && cancelled.data.params.requestId !== undefined
          ? requests.get(cancelled.data.params.requestId)
          : undefined;
      requestContext.run(undefined, () => dispatch?.(message));
      if (reservation) {
        // Let the SDK finish its queued cancellation and handler microtasks.
        // In SDK 1.31.0 ID 0 cancellation is ignored: its handler/reply must
        // enter before deciding whether a no-reply reservation can be freed.
        // built-ins and schema refusals may be cancelled without ever entering
        // our handlers or sending a reply. Running work settles in finally;
        // replies already writing retain capacity until stdout drains.
        setImmediate(() => {
          if (reservation.phase === "queued" || reservation.phase === "settled")
            releaseRequest(reservation);
        });
      }
    };
    await start();
    input.pipe(guardedInput);
  };
  try {
    await upstream.connect(transport);
    await server.connect(stdio);
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
