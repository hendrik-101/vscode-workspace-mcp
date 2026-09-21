/** Host-independent tool contract. URIs are complete URI strings, never OS paths. */
export interface RootInfo {
  uri: string;
  name: string;
  index: number;
}

/** All line and character positions are zero-based UTF-16 offsets. */
export interface Position {
  line: number;
  character: number;
}

export interface TextRange {
  start: Position;
  end: Position;
}

export interface UriInput {
  uri: string;
}
export interface ListInput extends UriInput {
  maxEntries?: number;
  /** Stateless continuation bound to the unchanged directory and workspace roots. */
  cursor?: string;
}
export interface ReadInput extends UriInput {
  /** Line selectors are mutually exclusive with range. */
  startLine?: number;
  /** Exclusive. Defaults to the document's line count. */
  endLine?: number;
  /** Exact half-open UTF-16 positions; never clamped or split inside surrogate pairs. */
  range?: TextRange;
  /** Reject positions from a different live document version. */
  version?: number;
  /** Maximum source lines per page: 1–1000, default 200. */
  maxLines?: number;
  /** Maximum UTF-16 code units including line endings: 2–64000, default 16000. */
  maxChars?: number;
}
export interface SearchInput extends UriInput {
  query: string;
  maxResults?: number;
  /** Opaque, single-use continuation; resend the same query and options. */
  cursor?: string;
  include?: string[];
  exclude?: string[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
  contextLines?: number;
}
export interface EditInput extends UriInput {
  version: number;
  edits: Array<{ range: TextRange; text: string }>;
}
export interface SaveInput extends UriInput {
  version: number;
}

export interface ShowInput extends UriInput {
  selection?: TextRange;
  preserveFocus?: boolean;
}
export const SYMBOL_TYPES = [
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
] as const;
export interface SymbolOptions {
  name?: string;
  kind?: number | (typeof SYMBOL_TYPES)[number];
  maxResults?: number;
  /** Offset into admitted, filtered results; resend the same filters. */
  offset?: number;
}
export interface SymbolsInput extends SymbolOptions {
  query: string;
}
export interface DocumentSymbolsInput extends UriInput, SymbolOptions {
  /** Required for a nonzero offset. */
  version?: number;
}
export interface SymbolResult {
  symbols: Array<{
    name: string;
    kind: number;
    type: (typeof SYMBOL_TYPES)[number] | "unknown";
    uri: string;
    /** Full range only when fullRangeKnown; otherwise a provider location. */
    range: TextRange;
    selectionRange?: TextRange;
    fullRangeKnown: boolean;
    containerName?: string;
  }>;
  version?: number;
  consistency: "document-version" | "live";
  nextOffset?: number;
  scanned: number;
  scanLimitReached: boolean;
  truncated: boolean;
  omitted: number;
}
/** Read-only provider query against the live buffer; optional version rejects stale positions. */
export interface NavigationInput extends UriInput {
  position: Position;
  version?: number;
}
export interface NavigationResult extends DocumentState {
  locations: Array<DocumentState & { range: TextRange }>;
  truncated: boolean;
  omitted: number;
}
export interface HoverResult extends DocumentState {
  /** Provider-authored text, never trusted instructions or executable commands. */
  untrusted: true;
  hovers: Array<{ contents: string[]; range?: TextRange }>;
  truncated: boolean;
  omitted: number;
}
export interface DiffInput extends UriInput {
  otherUri?: string;
  proposedText?: string;
  version?: number;
  preserveFocus?: boolean;
}
export interface FormatInput extends UriInput {
  version: number;
  range?: TextRange;
  tabSize?: number;
  insertSpaces?: boolean;
  apply?: boolean;
  includeEdits?: boolean;
}
export interface FormatResult extends DocumentState {
  edits?: EditInput["edits"];
  editCount: number;
  applied: boolean;
}

/** Provider previews are observations, never independently applicable edit plans. */
export namespace Refactoring {
  export interface RenameInput extends UriInput {
    version: number;
    position: Position;
    newName: string;
  }
  export interface ActionsInput extends UriInput {
    version: number;
    range: TextRange;
    kind: "quickfix" | "refactor";
  }
  export interface Preview {
    /** Automatic application is unsupported: public WorkspaceEdit hides operations. */
    supported: false;
    applicable: false;
    complete: false;
    reasons: Array<
      "OPAQUE_WORKSPACE_EDIT" | "COMMAND_REQUIRED" | "DISABLED" | "NO_EDIT"
    >;
    /** Only publicly inspectable text edits; never the complete provider operation. */
    documents: Array<DocumentState & { edits: EditInput["edits"] }>;
  }
  export interface RenameResult extends DocumentState {
    providerResult: boolean;
    preview: Preview;
  }
  export interface ActionsResult extends DocumentState {
    actions: Array<
      Preview & { title: string; kind?: string; preferred: boolean }
    >;
    truncated: boolean;
  }
}

export interface DocumentState {
  uri: string;
  version: number;
  dirty: boolean;
}
export interface ReadResult extends DocumentState {
  languageId: string;
  lineCount: number;
  /** Requested line envelope, retained for compatibility; see returnedRange for actual text. */
  startLine: number;
  endLine: number;
  text: string;
  requestedRange: TextRange;
  returnedRange: TextRange;
  truncated: boolean;
  /** Present only when truncated. Resume with this start, requestedRange.end and version. */
  nextPosition?: Position;
}
export interface ListResult {
  uri: string;
  entries: Array<{
    name: string;
    uri: string;
    kind: "file" | "directory" | "unknown";
  }>;
  truncated: boolean;
  /** Count of omitted symbolic links and unsafe provider entry names. */
  blockedEntries: number;
  /** Omitted entries beyond the scan or response bounds. */
  omittedEntries?: number;
  incomplete?: boolean;
  nextCursor?: string;
}
export interface SearchResult {
  uri: string;
  query: string;
  matches: Array<{
    uri: string;
    line: number;
    character: number;
    text: string;
    context?: Array<{ line: number; text: string }>;
    previewTruncated?: boolean;
  }>;
  filesSearched: number;
  nextCursor?: string;
  /** Searches observe live files across pages, never an atomic snapshot. */
  consistency?: "live";
  /** Cumulative hard limits: omitted work cannot be recovered by continuation. */
  limits?: string[];
  truncated: boolean;
  incomplete: boolean;
  errors: Array<{ uri: string; message: string }>;
}
export interface ContextResult {
  roots: RootInfo[];
  activeEditor?: DocumentState & {
    languageId: string;
    selection: TextRange;
    selectedText: string;
    selectionTruncated: boolean;
  };
  tabs: Array<{ uri: string; active: boolean; dirty: boolean }>;
  truncated: boolean;
}
export interface DiagnosticsResult {
  uri: string;
  diagnostics: Array<{
    range: TextRange;
    severity: "error" | "warning" | "information" | "hint";
    message: string;
    source?: string;
    code?: string | number;
  }>;
  truncated: boolean;
}

export interface WaitDiagnosticsInput extends UriInput {
  version: number;
  timeoutMs?: number;
}
export interface WaitDiagnosticsResult extends DiagnosticsResult {
  outcome: "event_observed" | "timeout";
  documentVersion: number;
  capturedAt: string;
  /** VS Code exposes no diagnostic analysis version or completion guarantee. */
  analysisComplete: "unknown";
}

export interface WorkspaceApi {
  /** Release resources owned by this bridge when its server stops. */
  dispose?(): void;
  show(input: ShowInput, signal?: AbortSignal): Promise<DocumentState>;
  workspaceSymbols(
    input: SymbolsInput,
    signal?: AbortSignal,
  ): Promise<SymbolResult>;
  documentSymbols(
    input: DocumentSymbolsInput,
    signal?: AbortSignal,
  ): Promise<SymbolResult>;
  definition(
    input: NavigationInput,
    signal?: AbortSignal,
  ): Promise<NavigationResult>;
  references(
    input: NavigationInput,
    signal?: AbortSignal,
  ): Promise<NavigationResult>;
  hover(input: NavigationInput, signal?: AbortSignal): Promise<HoverResult>;
  diff(input: DiffInput, signal?: AbortSignal): Promise<{ shown: boolean }>;
  format(input: FormatInput, signal?: AbortSignal): Promise<FormatResult>;
  rename(
    input: Refactoring.RenameInput,
    signal?: AbortSignal,
  ): Promise<Refactoring.RenameResult>;
  codeActions(
    input: Refactoring.ActionsInput,
    signal?: AbortSignal,
  ): Promise<Refactoring.ActionsResult>;
  roots(): Promise<RootInfo[]>;
  context(): Promise<ContextResult>;
  list(input: ListInput): Promise<ListResult>;
  read(input: ReadInput): Promise<ReadResult>;
  search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>;
  edit(input: EditInput, signal?: AbortSignal): Promise<DocumentState>;
  save(input: SaveInput, signal?: AbortSignal): Promise<DocumentState>;
  waitForDiagnostics(
    input: WaitDiagnosticsInput,
    signal?: AbortSignal,
  ): Promise<WaitDiagnosticsResult>;
  diagnostics(input: UriInput): Promise<DiagnosticsResult>;
}

export type WorkspaceErrorCode =
  | "SEARCH_INVALIDATED"
  | "SESSION_STOPPED"
  | "INVALID_ARGUMENT"
  | "OUTSIDE_WORKSPACE"
  | "SYMLINK_DENIED"
  | "WRITES_DISABLED"
  | "UNTRUSTED_WORKSPACE"
  | "AUTO_SAVE_ENABLED"
  | "VERSION_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "EDIT_FAILED"
  | "SAVE_FAILED";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
