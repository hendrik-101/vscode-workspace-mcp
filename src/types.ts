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
  /** Symbolic links are omitted and never followed. */
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
  roots(): Promise<RootInfo[]>;
  context(): Promise<ContextResult>;
  list(input: UriInput): Promise<ListResult>;
  read(input: ReadInput): Promise<ReadResult>;
  search(input: SearchInput): Promise<SearchResult>;
  edit(input: EditInput): Promise<DocumentState>;
  save(input: SaveInput): Promise<DocumentState>;
  diagnostics(input: UriInput): Promise<DiagnosticsResult>;
}

export type WorkspaceErrorCode =
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
