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
export interface ReadInput extends UriInput {
  startLine?: number;
  /** Exclusive. Defaults to the document's line count. */
  endLine?: number;
}
export interface SearchInput extends UriInput {
  query: string;
  maxResults?: number;
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
export interface SymbolsInput {
  query: string;
}
export interface SymbolResult {
  symbols: Array<{
    name: string;
    kind: number;
    uri: string;
    range: TextRange;
    containerName?: string;
  }>;
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
}
export interface FormatResult extends DocumentState {
  edits: EditInput["edits"];
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
  startLine: number;
  endLine: number;
  text: string;
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
}
export interface SearchResult {
  uri: string;
  query: string;
  matches: Array<{
    uri: string;
    line: number;
    character: number;
    text: string;
  }>;
  filesSearched: number;
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

export interface WorkspaceApi {
  /** Release resources owned by this bridge when its server stops. */
  dispose?(): void;
  show(input: ShowInput, signal?: AbortSignal): Promise<DocumentState>;
  workspaceSymbols(
    input: SymbolsInput,
    signal?: AbortSignal,
  ): Promise<SymbolResult>;
  documentSymbols(input: UriInput, signal?: AbortSignal): Promise<SymbolResult>;
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
  list(input: UriInput): Promise<ListResult>;
  read(input: ReadInput): Promise<ReadResult>;
  search(input: SearchInput): Promise<SearchResult>;
  edit(input: EditInput, signal?: AbortSignal): Promise<DocumentState>;
  save(input: SaveInput, signal?: AbortSignal): Promise<DocumentState>;
  diagnostics(input: UriInput): Promise<DiagnosticsResult>;
}

export type WorkspaceErrorCode =
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
