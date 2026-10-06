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
