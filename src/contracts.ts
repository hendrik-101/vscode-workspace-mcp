import { z } from "zod";

// Keep output shapes concise: safety limits live in workspace operations, while
// these schemas describe returned fields and distinguish success from errors.
// Preserve additive fields across server versions and independently merged tools.
const text = z.string();
const number = z.number();
const boolean = z.boolean();
const position = z.looseObject({ line: number, character: number });
const range = z.looseObject({ start: position, end: position });
const state = { uri: text, version: number, dirty: boolean };
const bounded = { truncated: boolean, omitted: number };
const edit = z.looseObject({ range, text });
const root = z.looseObject({ uri: text, name: text, index: number });
const symbol = z.looseObject({
  name: text,
  kind: number,
  type: z
    .enum([
      "file",
      "module",
      "namespace",
      "package",
      "class",
      "method",
      "property",
      "field",
      "constructor",
      "enum",
      "interface",
      "function",
      "variable",
      "constant",
      "string",
      "number",
      "boolean",
      "array",
      "object",
      "key",
      "null",
      "enummember",
      "struct",
      "event",
      "operator",
      "typeparameter",
      "unknown",
    ])
    .optional(),
  selectionRange: range.optional(),
  fullRangeKnown: boolean.optional(),
  uri: text,
  range,
  containerName: text.optional(),
});
// Optional metadata supports independent symbol/diagnostic rollout while making
// continuation and completeness fields visible to clients before integration.
const symbols = z.looseObject({
  symbols: z.array(symbol),
  ...bounded,
  version: number.optional(),
  consistency: z.enum(["document-version", "live"]).optional(),
  nextOffset: number.optional(),
  scanned: number.optional(),
  scanLimitReached: boolean.optional(),
});
const navigation = z.looseObject({
  ...state,
  locations: z.array(z.looseObject({ ...state, range })),
  ...bounded,
});
const diagnosticFields = {
  uri: text,
  diagnostics: z.array(
    z.looseObject({
      range,
      severity: z.enum(["error", "warning", "information", "hint"]),
      message: text,
      messageTruncated: boolean.optional(),
      source: text.optional(),
      sourceTruncated: boolean.optional(),
      code: z.union([text, number]).optional(),
      codeTruncated: boolean.optional(),
    }),
  ),
  truncated: boolean,
  counts: z
    .looseObject({
      error: number,
      warning: number,
      information: number,
      hint: number,
    })
    .optional(),
  total: number.optional(),
  inspected: number.optional(),
  matching: number.optional(),
  incomplete: boolean.optional(),
  snapshotId: text.optional(),
  nextOffset: number.optional(),
};
const preview = {
  previewAvailable: boolean.describe(
    "At least one visible text edit is present.",
  ),
  applicationSupported: z.literal(false),
  supported: z
    .literal(false)
    .describe("Legacy alias for applicationSupported."),
  applicable: z.literal(false),
  complete: z.literal(false),
  reasons: z.array(
    z.enum([
      "OPAQUE_WORKSPACE_EDIT",
      "COMMAND_REQUIRED",
      "DISABLED",
      "NO_EDIT",
    ]),
  ),
  documents: z.array(z.looseObject({ ...state, edits: z.array(edit) })),
};

const readFields = {
  ...state,
  languageId: text,
  lineCount: number,
  startLine: number,
  endLine: number,
  text,
  requestedRange: range,
  returnedRange: range,
  truncated: boolean,
  nextPosition: position.optional(),
};

export const results = {
  workspace_roots: z.array(root),
  editor_context: z.looseObject({
    roots: z.array(root),
    activeEditor: z
      .looseObject({
        ...state,
        languageId: text,
        selection: range,
        selectedText: text,
        selectionTruncated: boolean,
      })
      .optional(),
    tabs: z.array(
      z.looseObject({ uri: text, active: boolean, dirty: boolean }),
    ),
    truncated: boolean,
  }),
  list_directory: z.looseObject({
    uri: text,
    entries: z.array(
      z.looseObject({
        name: text,
        uri: text,
        kind: z.enum(["file", "directory", "unknown"]),
      }),
    ),
    truncated: boolean,
    blockedEntries: number,
    omittedEntries: number.optional(),
    incomplete: boolean.optional(),
    nextCursor: text.optional(),
  }),
  read_document: z.looseObject(readFields),
  read_symbol: z.looseObject({
    ...readFields,
    symbol: z.looseObject({
      name: text,
      kind: number,
      containerName: text.optional(),
      range,
      selectionRange: range,
    }),
  }),
  search_workspace: z.looseObject({
    uri: text,
    query: text,
    matches: z.array(
      z.looseObject({
        uri: text,
        line: number,
        character: number,
        text,
        context: z.array(z.looseObject({ line: number, text })).optional(),
        previewTruncated: boolean.optional(),
      }),
    ),
    filesSearched: number,
    nextCursor: text
      .optional()
      .describe("Pass as cursor with identical search options."),
    consistency: z.literal("live").optional(),
    limits: z.array(text).optional(),
    truncated: boolean,
    incomplete: boolean,
    errors: z.array(z.looseObject({ uri: text, message: text })),
  }),
  edit_document: z.looseObject(state),
  save_document: z.looseObject(state),
  get_diagnostics: z.looseObject(diagnosticFields),
  wait_for_diagnostics: z.looseObject({
    ...diagnosticFields,
    outcome: z.enum(["event_observed", "timeout"]),
    documentVersion: number,
    capturedAt: text,
    analysisComplete: z.literal("unknown"),
  }),
  show_document: z.looseObject(state),
  workspace_symbols: symbols,
  document_symbols: symbols,
  get_definition: navigation,
  get_references: navigation,
  get_hover: z.looseObject({
    ...state,
    untrusted: z.literal(true),
    hovers: z.array(
      z.looseObject({ contents: z.array(text), range: range.optional() }),
    ),
    ...bounded,
  }),
  show_diff: z.looseObject({ shown: boolean }),
  format_document: z.looseObject({
    ...state,
    edits: z.array(edit).optional(),
    editCount: number,
    applied: boolean,
  }),
  preview_rename: z.looseObject({
    ...state,
    providerResult: boolean,
    preview: z.looseObject(preview),
  }),
  preview_code_actions: z.looseObject({
    ...state,
    actions: z.array(
      z.looseObject({
        ...preview,
        title: text,
        kind: text.optional(),
        preferred: boolean,
      }),
    ),
    truncated: boolean,
  }),
};

export function outputSchema(name: keyof typeof results) {
  // SDK clients validate structured errors too. Keep both existing envelopes;
  // object-level refinement enforces exactly one at the server boundary.
  return z
    .strictObject({
      result: results[name].optional(),
      error: z.looseObject({ code: text, message: text }).optional(),
    })
    .refine(
      (value) => (value.result !== undefined) !== (value.error !== undefined),
      {
        message: "Return exactly one of result or error.",
      },
    )
    .meta({
      description: "Success: result. Failure: error with isError=true.",
      // Zod refinements are runtime-only; expose the same rule to MCP clients.
      oneOf: [{ required: ["result"] }, { required: ["error"] }],
    });
}
