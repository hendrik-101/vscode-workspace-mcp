import { WorkspaceError } from "./types.js";

/** Shared operation budgets keep the MCP schemas and workspace guards aligned. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_EDITS = 10_000;
export const MAX_REFACTOR_DOCUMENTS = 500;
export const MAX_REFACTOR_BYTES = 8 * 1024 * 1024;
export const MAX_DIAGNOSTICS = 5_000;
export const MAX_DIAGNOSTIC_CHARACTERS = 5 * 1024 * 1024;
// An 8 MiB control-character replacement can expand sixfold in JSON. Reserve
// room for 10,000 edit coordinates and the request envelope as well.
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_IN_FLIGHT_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_REFACTOR_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_IN_FLIGHT_REFACTOR_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
export const MAX_IN_FLIGHT_RESPONSE_BYTES = 256 * 1024 * 1024;

/** Safe budget messages contain only bridge-owned labels and byte counts. */
export class MemoryLimitError extends WorkspaceError {
  constructor(
    readonly budget:
      | "refactoringSource"
      | "refactoringSourcesInFlight"
      | "response"
      | "responsesInFlight",
    readonly requestedBytes: number,
  ) {
    super("LIMIT_EXCEEDED", MemoryLimitError.describe(budget, requestedBytes));
  }

  static describe(
    budget: MemoryLimitError["budget"],
    requestedBytes: number,
  ): string {
    const requested = (requestedBytes / (1024 * 1024)).toFixed(2);
    if (budget === "response" || budget === "responsesInFlight") {
      const limit =
        (budget === "response"
          ? MAX_RESPONSE_BYTES
          : MAX_IN_FLIGHT_RESPONSE_BYTES) /
        (1024 * 1024);
      return `Response memory would require at least ${requested} MiB; limit ${limit} MiB ${budget === "response" ? "per response" : "across unfinished responses"}, including JSON escaping and duplicate MCP content. Wait for earlier responses to finish or disconnect stalled clients, then retry. Request a smaller preview; formatting can use includeEdits: false.`;
    }
    const limit =
      (budget === "refactoringSource"
        ? MAX_REFACTOR_SOURCE_BYTES
        : MAX_IN_FLIGHT_REFACTOR_SOURCE_BYTES) /
      (1024 * 1024);
    return budget === "refactoringSource"
      ? `Refactoring source text would require ${requested} MiB; limit ${limit} MiB per operation (source and unique targets). Request a smaller refactoring or use VS Code's native Rename/Refactor UI.`
      : `Concurrent refactoring source text would require ${requested} MiB; limit ${limit} MiB across unfinished operations. Wait for earlier provider work to finish, then retry. Cancelling a request does not stop all providers.`;
  }
}
