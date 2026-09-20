import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import {
  WorkspaceError,
  type ShowInput,
  type SymbolsInput,
  type SymbolResult,
  type DiffInput,
  type FormatInput,
  type FormatResult,
  type ContextResult,
  type DiagnosticsResult,
  type DocumentState,
  type EditInput,
  type ListResult,
  type Position,
  type ReadInput,
  type ReadResult,
  type RootInfo,
  type SaveInput,
  type SearchInput,
  type SearchResult,
  type TextRange,
  type UriInput,
  type WorkspaceApi,
} from "./types";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const MAX_SEARCH_FILES = 200;
const MAX_SEARCH_ENTRIES = 2000;
const MAX_SEARCH_DEPTH = 12;
const MAX_SEARCH_CURSORS = 16;
const SEARCH_TTL = 5 * 60 * 1000;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_TOTAL_ENTRIES = 20_000;
const MAX_SEARCH_PAGES = 1000;
const MAX_SEARCH_URI = 8192;
const MAX_SEARCH_PENDING_CHARACTERS = 128 * 1024;

interface SearchEntry {
  uri: vscode.Uri;
  depth: number;
  type: vscode.FileType;
  offset?: number;
  version?: number;
  contentHash?: string;
}
interface SearchContinuation {
  fingerprint: string;
  expires: number;
  generation: number;
  pending: SearchEntry[];
  pendingCharacters: number;
  bytes: number;
  entries: number;
  pages: number;
  incomplete: boolean;
  limits: Set<string>;
}

/** Bounded dynamic programming avoids regexp backtracking on untrusted globs. */
function filenameFilter(
  patterns: string[],
  budget: { remaining: number },
): (path: string) => boolean {
  const compiled = patterns.map((pattern) => {
    const tokens: string[] = [];
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] === "*" && pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          tokens.push("**/");
          i++;
        } else tokens.push("**");
      } else tokens.push(pattern[i]!);
    }
    return { tokens, basename: !pattern.includes("/") };
  });
  return (path) =>
    compiled.some(({ tokens, basename }) => {
      const value = basename ? path.slice(path.lastIndexOf("/") + 1) : path;
      budget.remaining -= tokens.length * (value.length + 1);
      if (budget.remaining < 0)
        fail("LIMIT_EXCEEDED", "Filename matching exceeded its work budget.");
      let previous = new Uint8Array(value.length + 1);
      previous[0] = 1;
      for (const token of tokens) {
        const next = new Uint8Array(value.length + 1);
        if (token === "*" || token === "**" || token === "**/") {
          next[0] = previous[0]!;
          let reachable = previous[0]!;
          for (let i = 1; i <= value.length; i++) {
            if (token === "**/") {
              next[i] = previous[i]! || (value[i - 1] === "/" ? reachable : 0);
              reachable ||= previous[i]!;
            } else
              next[i] =
                previous[i]! ||
                (token === "**" || value[i - 1] !== "/" ? next[i - 1]! : 0);
          }
        } else {
          for (let i = 1; i <= value.length; i++)
            next[i] =
              previous[i - 1]! &&
              (token === "?" ? value[i - 1] !== "/" : token === value[i - 1])
                ? 1
                : 0;
        }
        previous = next;
      }
      return previous[value.length] === 1;
    });
}
const MAX_SEARCH_BYTES = 4 * MAX_FILE_BYTES;
const MAX_RESULTS = 100;
const MAX_PREVIEW = 1000;
const MAX_SELECTION = 4096;
const MAX_EDITS = 100;

function fail(
  code: ConstructorParameters<typeof WorkspaceError>[0],
  message: string,
): never {
  throw new WorkspaceError(code, message);
}

function integer(value: number, name: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) {
    fail("INVALID_ARGUMENT", `${name} must be an integer >= ${min}.`);
  }
}

function childPrefix(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function contains(root: vscode.Uri, uri: vscode.Uri): boolean {
  const base = root.path;
  const path = uri.path;
  return (
    root.scheme === uri.scheme &&
    root.authority === uri.authority &&
    root.query === uri.query &&
    !uri.fragment &&
    !root.fragment &&
    (path === base || path.startsWith(childPrefix(base)))
  );
}

/** Reject ambiguous paths before any filesystem operation. Never normalize traversal. */
function parseUri(value: string): vscode.Uri {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    fail(
      "INVALID_ARGUMENT",
      "A complete URI with an explicit scheme is required.",
    );
  }
  const rawPath = value
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/[^/?#]*)?/, "")
    .split(/[?#]/, 1)[0]!;
  if (/%(?![0-9a-f]{2})/i.test(value)) {
    fail(
      "INVALID_ARGUMENT",
      "Encoded traversal or ambiguous URI encoding is not allowed.",
    );
  }
  let uri: vscode.Uri;
  try {
    // Uri.parse tolerates malformed UTF-8 escapes; providers may interpret them
    // differently, so require one well-defined decoding before accepting a path.
    decodeURIComponent(rawPath);
    // Inspect every decoding layer: escaping individual hex digits can hide
    // dangerous sequences from a raw-string matcher. Literal percent signs
    // without hex digits remain ordinary filename characters after decoding.
    let layer = rawPath;
    for (let depth = 0; ; depth++) {
      if (/%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(layer))
        fail("INVALID_ARGUMENT", "Encoded traversal is not allowed.");
      const decoded = layer.replace(/(?:%[0-9a-f]{2})+/gi, (escapes) =>
        decodeURIComponent(escapes),
      );
      if (decoded === layer) break;
      if (depth >= 7)
        fail("INVALID_ARGUMENT", "URI encoding is nested too deeply.");
      layer = decoded;
    }
    uri = vscode.Uri.parse(value, true);
  } catch {
    return fail("INVALID_ARGUMENT", "Invalid URI.");
  }
  if (
    value.includes("#") ||
    /[\\\u0000-\u001f\u007f]/.test(rawPath) ||
    (uri.path !== "" && !uri.path.startsWith("/")) ||
    /[\\\u0000-\u001f\u007f]/.test(uri.path) ||
    uri.path
      .split("/")
      .some((segment) => segment === "." || segment === "..") ||
    uri.path.includes("//")
  ) {
    fail(
      "INVALID_ARGUMENT",
      "URI paths must be absolute and unambiguous, without fragments or traversal.",
    );
  }
  return uri;
}

function position(value: vscode.Position): Position {
  return { line: value.line, character: value.character };
}

function range(value: vscode.Range): TextRange {
  return { start: position(value.start), end: position(value.end) };
}

function state(document: vscode.TextDocument): DocumentState {
  return {
    uri: document.uri.toString(),
    version: document.version,
    dirty: document.isDirty,
  };
}

function isLink(stat: vscode.FileStat): boolean {
  return (stat.type & vscode.FileType.SymbolicLink) !== 0;
}

export class WorkspaceService implements WorkspaceApi {
  /**
   * @param allowWrites Callback rechecked immediately before each mutation.
   */
  constructor(private readonly allowWrites: () => boolean = () => false) {}

  private disposed = false;
  private readonly searchCursors = new Map<string, SearchContinuation>();
  private searchRoots: vscode.Disposable | undefined;
  private searchGeneration = 0;
  private activeSearches = 0;
  private readonly snapshots = new Map<string, string>();
  private readonly pendingSnapshots = new Set<string>();
  private snapshotProvider: vscode.Disposable | undefined;
  private readonly snapshotScheme = `workspace-mcp-diff-${randomUUID()}`;

  /** Releases in-memory diff snapshots and their content provider. */
  dispose(): void {
    this.disposed = true;
    this.searchRoots?.dispose();
    this.searchCursors.clear();
    this.snapshotProvider?.dispose();
    this.snapshotProvider = undefined;
    this.snapshots.clear();
    this.pendingSnapshots.clear();
  }

  private active(): void {
    if (this.disposed)
      fail("SESSION_STOPPED", "The workspace bridge has stopped.");
  }

  private exactRange(
    document: vscode.TextDocument,
    value: TextRange,
  ): vscode.Range {
    const start = this.exactPosition(document, value.start);
    const end = this.exactPosition(document, value.end);
    if (start.isAfter(end))
      fail("INVALID_ARGUMENT", "Range must run from start to end.");
    return new vscode.Range(start, end);
  }

  /** Reveals an admitted live document without editing or saving it. */
  async show(input: ShowInput, signal?: AbortSignal): Promise<DocumentState> {
    signal?.throwIfAborted();
    const document = await this.document(parseUri(input.uri));
    this.text(document);
    const selection = input.selection
      ? this.exactRange(document, input.selection)
      : undefined;
    signal?.throwIfAborted();
    this.active();
    await vscode.window.showTextDocument(document, {
      preserveFocus: input.preserveFocus ?? true,
      preview: false,
      ...(selection ? { selection } : {}),
    });
    this.currentRoot(document.uri);
    return state(document);
  }

  private async symbols(
    items: readonly vscode.SymbolInformation[],
    signal?: AbortSignal,
  ): Promise<SymbolResult> {
    const result: SymbolResult = {
      symbols: [],
      truncated: items.length > MAX_LIST_ENTRIES,
      omitted: 0,
    };
    // Cache only within this result, including failures. Many symbols share a file.
    const authorized = new Map<string, Promise<vscode.FileStat>>();
    for (const item of items.slice(0, MAX_LIST_ENTRIES)) {
      signal?.throwIfAborted();
      this.active();
      if (result.symbols.length >= MAX_RESULTS) {
        result.truncated = true;
        break;
      }
      try {
        const uri = parseUri(item.location.uri.toString());
        const key = uri.toString();
        let check = authorized.get(key);
        if (!check) {
          check = this.authorize(uri);
          authorized.set(key, check);
        }
        await check;
        this.currentRoot(uri);
        result.symbols.push({
          name: item.name.slice(0, MAX_PREVIEW),
          kind: item.kind,
          uri: uri.toString(),
          range: range(item.location.range),
          ...(item.containerName
            ? { containerName: item.containerName.slice(0, MAX_PREVIEW) }
            : {}),
        });
      } catch {
        result.omitted++;
      }
    }
    signal?.throwIfAborted();
    this.active();
    // Roots can change while other symbol targets are being authorized.
    result.symbols = result.symbols.filter((item) => {
      try {
        this.currentRoot(parseUri(item.uri));
        return true;
      } catch {
        result.omitted++;
        return false;
      }
    });
    return result;
  }

  /** Queries registered language providers; empty results do not prove provider availability. */
  async workspaceSymbols(
    { query }: SymbolsInput,
    signal?: AbortSignal,
  ): Promise<SymbolResult> {
    signal?.throwIfAborted();
    this.active();
    if (!query || query.length > MAX_SELECTION)
      fail("INVALID_ARGUMENT", "Provide a query of 1 to 4096 characters.");
    const items = await vscode.commands.executeCommand<
      vscode.SymbolInformation[]
    >("vscode.executeWorkspaceSymbolProvider", query);
    signal?.throwIfAborted();
    return this.symbols(items ?? [], signal);
  }

  /** Returns bounded symbol locations from a document's registered provider. */
  async documentSymbols(
    { uri: value }: UriInput,
    signal?: AbortSignal,
  ): Promise<SymbolResult> {
    signal?.throwIfAborted();
    const uri = parseUri(value);
    const document = await this.document(uri);
    this.text(document);
    signal?.throwIfAborted();
    this.active();
    const items = await vscode.commands.executeCommand<
      Array<vscode.DocumentSymbol | vscode.SymbolInformation>
    >("vscode.executeDocumentSymbolProvider", uri);
    signal?.throwIfAborted();
    this.currentRoot(uri);
    const flat: vscode.SymbolInformation[] = [];
    let omittedChildren = false;
    // An iterative depth-first traversal bounds both work and nesting depth.
    const stack = (items ?? [])
      .slice(0, MAX_LIST_ENTRIES)
      .map((item) => ({ item, container: "" }))
      .reverse();
    while (stack.length && flat.length < MAX_LIST_ENTRIES) {
      const { item, container } = stack.pop()!;
      if (!("children" in item)) flat.push(item);
      else {
        flat.push(
          new vscode.SymbolInformation(
            item.name,
            item.kind,
            container,
            new vscode.Location(uri, item.selectionRange),
          ),
        );
        const room = MAX_LIST_ENTRIES - flat.length - stack.length;
        omittedChildren ||= item.children.length > Math.max(0, room);
        stack.push(
          ...item.children
            .slice(0, Math.max(0, room))
            .map((child) => ({
              item: child,
              container: item.name.slice(0, MAX_PREVIEW),
            }))
            .reverse(),
        );
      }
    }
    const result = await this.symbols(flat, signal);
    result.truncated ||=
      omittedChildren ||
      !!stack.length ||
      (items?.length ?? 0) > MAX_LIST_ENTRIES;
    return result;
  }

  /** Opens a visual diff, optionally against a bounded read-only proposal in memory. */
  async diff(
    input: DiffInput,
    signal?: AbortSignal,
  ): Promise<{ shown: boolean }> {
    signal?.throwIfAborted();
    if ((input.otherUri === undefined) === (input.proposedText === undefined))
      fail(
        "INVALID_ARGUMENT",
        "Provide exactly one of otherUri or proposedText.",
      );
    const document = await this.document(parseUri(input.uri));
    this.text(document);
    signal?.throwIfAborted();
    this.active();
    let right: vscode.Uri;
    let snapshot: string | undefined;
    if (input.otherUri !== undefined) {
      const other = await this.document(parseUri(input.otherUri));
      this.text(other);
      right = other.uri;
    } else {
      this.expected(document, input.version ?? 0);
      if (Buffer.byteLength(input.proposedText!) > MAX_FILE_BYTES)
        fail("LIMIT_EXCEEDED", "Proposal exceeds 1 MiB.");
      if (!this.snapshotProvider)
        this.snapshotProvider =
          vscode.workspace.registerTextDocumentContentProvider(
            this.snapshotScheme,
            {
              provideTextDocumentContent: (uri) => {
                const text = this.snapshots.get(uri.toString());
                if (text === undefined)
                  throw vscode.FileSystemError.FileNotFound(uri);
                return text;
              },
            },
          );
      if (this.snapshots.size >= 8) {
        const expired = [...this.snapshots.keys()].find(
          (key) => !this.pendingSnapshots.has(key),
        );
        if (expired === undefined)
          fail(
            "LIMIT_EXCEEDED",
            "All eight diff snapshots are still opening. Retry after a diff completes.",
          );
        this.snapshots.delete(expired);
      }
      right = vscode.Uri.from({
        scheme: this.snapshotScheme,
        path: `/${randomUUID()}/proposal`,
      });
      snapshot = right.toString();
      this.snapshots.set(snapshot, input.proposedText!);
      this.pendingSnapshots.add(snapshot);
    }
    try {
      this.currentRoot(document.uri);
      if (input.otherUri !== undefined) this.currentRoot(right);
      signal?.throwIfAborted();
      await vscode.commands.executeCommand(
        "vscode.diff",
        document.uri,
        right,
        "Workspace MCP: Compare",
        { preserveFocus: input.preserveFocus ?? true, preview: true },
      );
      signal?.throwIfAborted();
      this.currentRoot(document.uri);
      if (input.otherUri !== undefined) this.currentRoot(right);
      return { shown: true };
    } catch (error) {
      if (snapshot !== undefined) this.snapshots.delete(snapshot);
      throw error;
    } finally {
      if (snapshot !== undefined) this.pendingSnapshots.delete(snapshot);
    }
  }

  /** Computes formatting edits; applying them uses the ordinary guarded edit path. */
  async format(
    input: FormatInput,
    signal?: AbortSignal,
  ): Promise<FormatResult> {
    signal?.throwIfAborted();
    if (input.apply) this.writable();
    const document = await this.document(parseUri(input.uri));
    this.text(document);
    this.expected(document, input.version);
    const settings = vscode.workspace.getConfiguration("editor", document);
    const options = {
      tabSize: input.tabSize ?? settings.get<number>("tabSize", 4),
      insertSpaces:
        input.insertSpaces ?? settings.get<boolean>("insertSpaces", true),
    };
    integer(options.tabSize, "tabSize", 1);
    if (options.tabSize > 32)
      fail("INVALID_ARGUMENT", "tabSize must not exceed 32.");
    signal?.throwIfAborted();
    this.active();
    const supplied = input.range
      ? await vscode.commands.executeCommand<vscode.TextEdit[]>(
          "vscode.executeFormatRangeProvider",
          document.uri,
          this.exactRange(document, input.range),
          options,
        )
      : await vscode.commands.executeCommand<vscode.TextEdit[]>(
          "vscode.executeFormatDocumentProvider",
          document.uri,
          options,
        );
    signal?.throwIfAborted();
    this.currentRoot(document.uri);
    this.expected(document, input.version);
    if ((supplied?.length ?? 0) > MAX_EDITS)
      fail("LIMIT_EXCEEDED", "Formatter returned more than 100 edits.");
    let bytes = 0;
    const edits = (supplied ?? []).map((item) => {
      this.exactRange(document, range(item.range));
      bytes += Buffer.byteLength(item.newText);
      if (bytes > MAX_FILE_BYTES)
        fail("LIMIT_EXCEEDED", "Formatting edits exceed 1 MiB.");
      return { range: range(item.range), text: item.newText };
    });
    this.checkedEdits(document, edits);
    const applied = !!input.apply && edits.length > 0;
    const final = applied
      ? await this.edit(
          { uri: input.uri, version: input.version, edits },
          signal,
        )
      : state(document);
    return { ...final, edits, applied };
  }

  private currentRoot(uri: vscode.Uri): vscode.Uri {
    this.active();
    const roots = vscode.workspace.workspaceFolders ?? [];
    // Prefer the outer root so that a nested workspace cannot hide a symlink ancestor.
    const candidates = roots
      .map((folder) => parseUri(folder.uri.toString()))
      .filter((root) => contains(root, uri))
      .sort((a, b) => a.path.length - b.path.length);
    return (
      candidates[0] ??
      fail(
        "OUTSIDE_WORKSPACE",
        "URI is outside the currently active workspace roots.",
      )
    );
  }

  private stillAllowed(uri: vscode.Uri, root: vscode.Uri): void {
    this.active();
    const active = (vscode.workspace.workspaceFolders ?? []).some(
      (folder) => folder.uri.toString() === root.toString(),
    );
    if (!active || !contains(root, uri)) {
      fail(
        "OUTSIDE_WORKSPACE",
        "Workspace roots changed during the operation.",
      );
    }
  }

  private async authorize(uri: vscode.Uri): Promise<vscode.FileStat> {
    const root = this.currentRoot(uri);
    const base = root.path;
    const target = uri.path;
    const remainder =
      target === base
        ? []
        : target.slice(base.length).replace(/^\//, "").split("/");
    let current = root;
    let stat = await vscode.workspace.fs.stat(current);
    this.stillAllowed(uri, root);
    if (isLink(stat)) fail("SYMLINK_DENIED", "Symbolic links are not allowed.");
    for (const [index, segment] of remainder.entries()) {
      if ((stat.type & vscode.FileType.Directory) === 0) {
        fail("NOT_A_DIRECTORY", "An ancestor is not a directory.");
      }
      // Stat the exact requested endpoint, including its trailing slash.
      current =
        index === remainder.length - 1
          ? uri
          : current.with({ path: `${childPrefix(current.path)}${segment}` });
      stat = await vscode.workspace.fs.stat(current);
      this.stillAllowed(uri, root);
      if (isLink(stat))
        fail("SYMLINK_DENIED", "Symbolic links are not allowed.");
    }
    return stat;
  }

  private async document(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const stat = await this.authorize(uri);
    if ((stat.type & vscode.FileType.File) === 0)
      fail("NOT_A_FILE", "URI must identify a workspace file.");
    const open = vscode.workspace.textDocuments.find(
      (document) =>
        !document.isClosed && document.uri.toString() === uri.toString(),
    );
    if (open) {
      this.text(open);
      return open;
    }
    if (stat.size > MAX_FILE_BYTES)
      fail("LIMIT_EXCEEDED", "File exceeds the 1 MiB limit.");
    const document = await vscode.workspace.openTextDocument(uri);
    this.currentRoot(uri);
    if (document.uri.toString() !== uri.toString()) {
      fail(
        "OUTSIDE_WORKSPACE",
        "The opened document does not match the requested URI.",
      );
    }
    return document;
  }

  private text(document: vscode.TextDocument): string {
    const lastLine = document.lineAt(document.lineCount - 1);
    if (document.offsetAt(lastLine.range.end) > MAX_FILE_BYTES) {
      fail("LIMIT_EXCEEDED", "Document buffer exceeds the 1 MiB limit.");
    }
    const text = document.getText();
    if (Buffer.byteLength(text) > MAX_FILE_BYTES)
      fail("LIMIT_EXCEEDED", "Document buffer exceeds the 1 MiB limit.");
    return text;
  }

  private writable(): void {
    this.active();
    if (!this.allowWrites())
      fail("WRITES_DISABLED", "Workspace writes are disabled.");
    if (!vscode.workspace.isTrusted)
      fail("UNTRUSTED_WORKSPACE", "Workspace trust is required for writes.");
  }

  private expected(document: vscode.TextDocument, version: number): void {
    integer(version, "version", 1);
    if (document.version !== version)
      fail(
        "VERSION_CONFLICT",
        "Document changed. Read it again before writing.",
      );
  }

  /** Lists the currently admitted workspace folders as complete URIs. */
  async roots(): Promise<RootInfo[]> {
    this.active();
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      index: folder.index,
    }));
  }

  /**
   * Returns the active editor and open text tabs that remain inside admitted
   * workspace roots, omitting inaccessible or out-of-workspace resources.
   */
  async context(): Promise<ContextResult> {
    const result: ContextResult = {
      roots: await this.roots(),
      tabs: [],
      truncated: false,
    };
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      try {
        const uri = parseUri(editor.document.uri.toString());
        await this.authorize(uri);
        this.currentRoot(uri);
        const selection = editor.selection;
        const start = editor.document.offsetAt(selection.start);
        const end = editor.document.offsetAt(selection.end);
        const capped = new vscode.Range(
          selection.start,
          editor.document.positionAt(Math.min(end, start + MAX_SELECTION)),
        );
        result.activeEditor = {
          ...state(editor.document),
          languageId: editor.document.languageId,
          selection: range(selection),
          selectedText: editor.document.getText(capped),
          selectionTruncated: end - start > MAX_SELECTION,
        };
      } catch {
        /* Outside-workspace and inaccessible documents are excluded from context. */
      }
    }
    const seen = new Set<string>();
    let inspected = 0;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (++inspected > MAX_LIST_ENTRIES) {
          result.truncated = true;
          break;
        }
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri;
        if (seen.has(uri.toString())) continue;
        if (result.tabs.length >= MAX_RESULTS) {
          result.truncated = true;
          break;
        }
        try {
          await this.authorize(parseUri(uri.toString()));
          this.currentRoot(uri);
          result.tabs.push({
            uri: uri.toString(),
            active: tab.isActive,
            dirty: tab.isDirty,
          });
          seen.add(uri.toString());
        } catch {
          /* Do not leak non-workspace tabs or provider errors. */
        }
      }
      if (result.truncated) break;
    }
    // An await while inspecting tabs may have changed the workspace.
    result.roots = await this.roots();
    result.tabs = result.tabs.filter((tab) => {
      try {
        this.currentRoot(parseUri(tab.uri));
        return true;
      } catch {
        return false;
      }
    });
    if (result.activeEditor) {
      try {
        this.currentRoot(parseUri(result.activeEditor.uri));
      } catch {
        delete result.activeEditor;
      }
    }
    return result;
  }

  /**
   * Lists a workspace directory without following symbolic links.
   * The result counts blocked entries and reports whether the entry limit was reached.
   */
  async list({ uri: value }: UriInput): Promise<ListResult> {
    const uri = parseUri(value);
    const stat = await this.authorize(uri);
    if ((stat.type & vscode.FileType.Directory) === 0)
      fail("NOT_A_DIRECTORY", "URI must identify a directory.");
    const children = await vscode.workspace.fs.readDirectory(uri);
    this.currentRoot(uri);
    const result: ListResult = {
      uri: uri.toString(),
      entries: [],
      truncated: children.length > MAX_LIST_ENTRIES,
      blockedEntries: 0,
    };
    for (const [name, type] of children.slice(0, MAX_LIST_ENTRIES)) {
      if ((type & vscode.FileType.SymbolicLink) !== 0) {
        result.blockedEntries++;
        continue;
      }
      let child: vscode.Uri;
      try {
        child = this.child(uri, name);
      } catch (error) {
        if (
          !(error instanceof WorkspaceError) ||
          error.code !== "INVALID_ARGUMENT"
        )
          throw error;
        result.blockedEntries++;
        continue;
      }
      result.entries.push({
        name,
        uri: child.toString(),
        kind:
          (type & vscode.FileType.Directory) !== 0
            ? "directory"
            : (type & vscode.FileType.File) !== 0
              ? "file"
              : "unknown",
      });
    }
    return result;
  }

  private child(parent: vscode.Uri, name: string): vscode.Uri {
    if (
      !name ||
      name === "." ||
      name === ".." ||
      // Unicode mode matches lone surrogates but preserves valid surrogate pairs.
      /[/\\\u0000-\u001f\u007f\ud800-\udfff]/u.test(name)
    ) {
      fail("INVALID_ARGUMENT", "Provider returned an unsafe directory entry.");
    }
    const uri = parent.with({
      path: `${childPrefix(parent.path)}${name}`,
    });
    parseUri(uri.toString());
    this.currentRoot(uri);
    return uri;
  }

  /**
   * Reads a zero-based, half-open line range from the current live document.
   * Unsaved buffer content takes precedence over the provider's stored bytes.
   */
  async read({
    uri: value,
    startLine = 0,
    endLine,
  }: ReadInput): Promise<ReadResult> {
    integer(startLine, "startLine");
    const document = await this.document(parseUri(value));
    this.text(document);
    const end = endLine ?? document.lineCount;
    integer(end, "endLine");
    if (startLine > end || end > document.lineCount)
      fail("INVALID_ARGUMENT", "Line range is outside the document.");
    const start =
      startLine === document.lineCount
        ? document.lineAt(document.lineCount - 1).range.end
        : new vscode.Position(startLine, 0);
    const finish =
      end === document.lineCount
        ? document.lineAt(document.lineCount - 1).range.end
        : new vscode.Position(end, 0);
    return {
      ...state(document),
      languageId: document.languageId,
      lineCount: document.lineCount,
      startLine,
      endLine: end,
      text: document.getText(new vscode.Range(start, finish)),
    };
  }

  /** Progressive live search. Cursors retain traversal positions, never source text. */
  async search(
    input: SearchInput,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    signal?.throwIfAborted();
    this.active();
    const {
      uri: value,
      query,
      maxResults = MAX_RESULTS,
      cursor,
      include = [],
      exclude = [],
      caseSensitive = true,
      wholeWord = false,
      contextLines = 0,
    } = input;
    if (
      typeof query !== "string" ||
      !query ||
      query.length > MAX_SELECTION ||
      /[\r\n]/.test(query)
    )
      fail(
        "INVALID_ARGUMENT",
        "query must be a nonempty single-line literal of at most 4096 characters.",
      );
    integer(maxResults, "maxResults", 1);
    integer(contextLines, "contextLines");
    if (
      maxResults > MAX_RESULTS ||
      contextLines > 5 ||
      typeof caseSensitive !== "boolean" ||
      typeof wholeWord !== "boolean"
    )
      fail(
        "INVALID_ARGUMENT",
        "Invalid search options; maxResults is at most 100 and contextLines at most 5.",
      );
    for (const patterns of [include, exclude]) {
      if (
        !Array.isArray(patterns) ||
        patterns.length > 20 ||
        patterns.some(
          (p) =>
            typeof p !== "string" || !p || p.length > 256 || /[\\\r\n]/.test(p),
        )
      )
        fail(
          "INVALID_ARGUMENT",
          "Filters must contain at most 20 filename globs of 1 to 256 characters.",
        );
    }
    if (value.length > MAX_SEARCH_URI)
      fail("INVALID_ARGUMENT", "Search URI exceeds 8192 characters.");
    const uri = parseUri(value);
    if (uri.toString().length > MAX_SEARCH_URI)
      fail("INVALID_ARGUMENT", "Encoded search URI exceeds 8192 characters.");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          uri.toString(),
          query,
          maxResults,
          include,
          exclude,
          caseSensitive,
          wholeWord,
          contextLines,
        ]),
      )
      .digest("hex");
    this.searchRoots ??= vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.searchGeneration++;
      this.searchCursors.clear();
    });
    for (const [key, state] of this.searchCursors) {
      if (state.expires <= Date.now()) this.searchCursors.delete(key);
    }
    let state: SearchContinuation;
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || cursor.length !== 36)
        fail("INVALID_ARGUMENT", "Invalid search cursor. Restart the search.");
      const saved = this.searchCursors.get(cursor);
      // Consume synchronously before any await: concurrent/replayed pages fail closed.
      this.searchCursors.delete(cursor);
      if (!saved || saved.fingerprint !== fingerprint)
        fail(
          "SEARCH_INVALIDATED",
          "Search cursor expired, was invalidated, or does not match these options. Restart the search.",
        );
      state = saved;
    } else {
      state = {
        fingerprint,
        expires: Date.now() + SEARCH_TTL,
        generation: this.searchGeneration,
        pending: [],
        pendingCharacters: 0,
        bytes: 0,
        entries: 0,
        pages: 0,
        incomplete: false,
        limits: new Set(),
      };
    }
    if (this.activeSearches >= MAX_SEARCH_CURSORS)
      fail("LIMIT_EXCEEDED", "Too many searches are running.");
    this.activeSearches++;
    try {
      const checkpoint = () => {
        signal?.throwIfAborted();
        this.currentRoot(uri);
        if (
          state.generation !== this.searchGeneration ||
          state.expires <= Date.now()
        )
          fail(
            "SEARCH_INVALIDATED",
            "Workspace roots changed or search expired. Restart the search.",
          );
      };
      checkpoint();
      const initialStat = await this.authorize(uri);
      checkpoint();
      const enqueue = (item: SearchEntry) => {
        const characters = item.uri.toString().length;
        if (
          state.pending.length >= MAX_SEARCH_ENTRIES ||
          state.pendingCharacters + characters > MAX_SEARCH_PENDING_CHARACTERS
        ) {
          state.limits.add("pendingEntries");
          return;
        }
        state.pending.push(item);
        state.pendingCharacters += characters;
      };
      if (cursor === undefined)
        enqueue({ uri, depth: 0, type: initialStat.type });
      const filterBudget = { remaining: 1_000_000 };
      const accepts = filenameFilter(include, filterBudget);
      const rejects = filenameFilter(exclude, filterBudget);
      const literal = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        caseSensitive ? "g" : "giu",
      );
      const result: SearchResult = {
        uri: uri.toString(),
        query,
        matches: [],
        filesSearched: 0,
        truncated: false,
        incomplete: state.incomplete,
        errors: [],
        consistency: "live",
        limits: [],
      };
      let bytes = 0;
      let entries = 0;
      let files = 0;
      state.pages++;
      while (state.pending.length) {
        checkpoint();
        if (
          state.bytes >= MAX_SEARCH_TOTAL_BYTES ||
          state.entries >= MAX_SEARCH_TOTAL_ENTRIES ||
          state.pages > MAX_SEARCH_PAGES
        ) {
          state.limits.add("totalWork");
          state.pending = [];
          break;
        }
        if (
          entries >= MAX_SEARCH_ENTRIES ||
          files >= MAX_SEARCH_FILES ||
          bytes >= MAX_SEARCH_BYTES ||
          result.matches.length >= maxResults
        )
          break;
        const item = state.pending.pop()!;
        state.pendingCharacters -= item.uri.toString().length;
        entries++;
        state.entries++;
        try {
          if ((item.type & vscode.FileType.SymbolicLink) !== 0)
            fail("SYMLINK_DENIED", "Symbolic link skipped.");
          if ((item.type & vscode.FileType.Directory) !== 0) {
            if (item.depth >= MAX_SEARCH_DEPTH) {
              state.limits.add("depth");
              continue;
            }
            await this.authorize(item.uri);
            checkpoint();
            const children = await vscode.workspace.fs.readDirectory(item.uri);
            checkpoint();
            // Providers return whole arrays; retain only a bounded frontier, never reread a directory.
            const capacity = MAX_SEARCH_ENTRIES - state.pending.length;
            if (children.length > capacity) state.limits.add("pendingEntries");
            for (const [name, type] of children.slice(0, capacity).reverse()) {
              try {
                const child = this.child(item.uri, name);
                if (child.toString().length > MAX_SEARCH_URI) {
                  state.limits.add("uriLength");
                  continue;
                }
                enqueue({ uri: child, depth: item.depth + 1, type });
              } catch {
                state.incomplete = true;
                if (result.errors.length < MAX_RESULTS)
                  result.errors.push({
                    uri: item.uri.toString(),
                    message: "Unsafe provider entry name skipped.",
                  });
              }
            }
          } else if ((item.type & vscode.FileType.File) !== 0) {
            const relative =
              item.depth === 0
                ? item.uri.path.slice(item.uri.path.lastIndexOf("/") + 1)
                : item.uri.path.slice(childPrefix(uri.path).length);
            if ((include.length && !accepts(relative)) || rejects(relative))
              continue;
            files++;
            const document = await this.document(item.uri);
            checkpoint();
            if (item.version !== undefined && document.version !== item.version)
              fail(
                "SEARCH_INVALIDATED",
                "The continued live document changed. Restart the search.",
              );
            const text = this.text(document);
            const contentHash = createHash("sha256").update(text).digest("hex");
            if (
              item.contentHash !== undefined &&
              item.contentHash !== contentHash
            )
              fail(
                "SEARCH_INVALIDATED",
                "The continued live document changed. Restart the search.",
              );
            const size = Buffer.byteLength(text);
            state.bytes += size;
            if (state.bytes > MAX_SEARCH_TOTAL_BYTES) {
              state.limits.add("totalWork");
              state.pending = [];
              break;
            }
            if (bytes + size > MAX_SEARCH_BYTES) {
              enqueue(item);
              break;
            }
            bytes += size;
            result.filesSearched++;
            literal.lastIndex = item.offset ?? 0;
            let match: RegExpExecArray | null;
            while ((match = literal.exec(text)) !== null) {
              const offset = match.index;
              if (
                wholeWord &&
                (/[A-Za-z0-9_]/.test(text[offset - 1] ?? "") ||
                  /[A-Za-z0-9_]/.test(text[offset + match[0].length] ?? ""))
              )
                continue;
              if (result.matches.length >= maxResults) {
                enqueue({
                  ...item,
                  offset,
                  version: document.version,
                  contentHash,
                });
                break;
              }
              const at = document.positionAt(offset);
              const context: Array<{ line: number; text: string }> = [];
              if (contextLines) {
                for (
                  let line = Math.max(0, at.line - contextLines);
                  line <=
                  Math.min(document.lineCount - 1, at.line + contextLines);
                  line++
                )
                  context.push({
                    line,
                    text: document.lineAt(line).text.slice(0, MAX_PREVIEW),
                  });
              }
              result.matches.push({
                uri: item.uri.toString(),
                line: at.line,
                character: at.character,
                text: document
                  .lineAt(at.line)
                  .text.slice(
                    Math.max(0, at.character - 100),
                    at.character + MAX_PREVIEW,
                  ),
                ...(contextLines ? { context } : {}),
              });
            }
          } else fail("NOT_A_FILE", "Entry has an unsupported file type.");
        } catch (error) {
          checkpoint();
          if (filterBudget.remaining < 0) {
            state.limits.add("filterWork");
            state.pending = [];
            break;
          }
          if (
            error instanceof WorkspaceError &&
            error.code === "SEARCH_INVALIDATED"
          )
            throw error;
          state.incomplete = true;
          if (result.errors.length < MAX_RESULTS)
            result.errors.push({
              uri: item.uri.toString(),
              message:
                error instanceof WorkspaceError
                  ? error.message
                  : "Entry could not be read by the workspace filesystem provider.",
            });
          else state.limits.add("errors");
        }
      }
      checkpoint();
      result.limits = [...state.limits];
      if (state.pending.length) {
        // Bound idle cursor storage. Evicted cursors fail explicitly when reused.
        while (this.searchCursors.size >= MAX_SEARCH_CURSORS)
          this.searchCursors.delete(this.searchCursors.keys().next().value!);
        result.nextCursor = randomUUID();
        this.searchCursors.set(result.nextCursor, state);
      }
      result.truncated = !!result.nextCursor || state.limits.size > 0;
      result.incomplete = state.incomplete || result.truncated;
      return result;
    } finally {
      this.activeSearches--;
    }
  }

  private exactPosition(
    document: vscode.TextDocument,
    value: Position,
  ): vscode.Position {
    if (!value || typeof value !== "object")
      fail("INVALID_ARGUMENT", "An edit position is required.");
    integer(value.line, "line");
    integer(value.character, "character");
    if (
      value.line >= document.lineCount ||
      value.character > document.lineAt(value.line).text.length
    ) {
      fail(
        "INVALID_ARGUMENT",
        "Edit position is outside the document; positions are never clamped.",
      );
    }
    return new vscode.Position(value.line, value.character);
  }

  private checkedEdits(
    document: vscode.TextDocument,
    edits: EditInput["edits"],
  ) {
    const original = this.text(document);
    const checked = edits
      .map((edit) => {
        if (!edit || !edit.range || typeof edit.text !== "string")
          fail("INVALID_ARGUMENT", "Invalid text edit.");
        const start = this.exactPosition(document, edit.range.start);
        const end = this.exactPosition(document, edit.range.end);
        if (start.isAfter(end))
          fail("INVALID_ARGUMENT", "Edit range must run from start to end.");
        return {
          range: new vscode.Range(start, end),
          text: edit.text,
          start: document.offsetAt(start),
          end: document.offsetAt(end),
        };
      })
      .sort((a, b) => a.start - b.start || a.end - b.end);
    let addedBytes = 0;
    for (let i = 0; i < checked.length; i++) {
      const edit = checked[i]!;
      const previous = checked[i - 1];
      if (
        previous &&
        (edit.start < previous.end || edit.start === previous.start)
      ) {
        fail(
          "INVALID_ARGUMENT",
          "Edit ranges must not overlap or share an insertion point.",
        );
      }
      addedBytes += Buffer.byteLength(edit.text);
      if (addedBytes > MAX_FILE_BYTES)
        fail("LIMIT_EXCEEDED", "Replacement text exceeds the 1 MiB limit.");
    }
    const parts: string[] = [];
    let previousEnd = 0;
    for (const edit of checked) {
      parts.push(original.slice(previousEnd, edit.start), edit.text);
      previousEnd = edit.end;
    }
    parts.push(original.slice(previousEnd));
    if (Buffer.byteLength(parts.join("")) > MAX_FILE_BYTES) {
      fail("LIMIT_EXCEEDED", "Edited document would exceed the 1 MiB limit.");
    }
    return checked;
  }

  /**
   * Applies version-checked edits to a live buffer without saving it.
   * Write approval, Workspace Trust, disabled Auto Save, and a non-aborted signal
   * are rechecked before the edit is handed to VS Code.
   */
  async edit(
    { uri: value, version, edits }: EditInput,
    signal?: AbortSignal,
  ): Promise<DocumentState> {
    signal?.throwIfAborted();
    this.writable();
    if (
      !Array.isArray(edits) ||
      edits.length === 0 ||
      edits.length > MAX_EDITS
    ) {
      fail("INVALID_ARGUMENT", "Provide between 1 and 100 edits.");
    }
    const uri = parseUri(value);
    const document = await this.document(uri);
    this.expected(document, version);
    const checked = this.checkedEdits(document, edits);
    await this.authorize(uri);
    this.writable();
    this.expected(document, version);
    if (
      vscode.workspace
        .getConfiguration("files", document)
        .get<string>("autoSave", "off") !== "off"
    ) {
      fail(
        "AUTO_SAVE_ENABLED",
        "Disable automatic saving for this document before applying agent edits. Changes must remain unsaved until explicitly saved.",
      );
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of checked)
      workspaceEdit.replace(uri, edit.range, edit.text);
    // No await between the version check and applying the edit. VS Code also snapshots
    // open document versions when serializing WorkspaceEdit to the main thread.
    signal?.throwIfAborted();
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) fail("EDIT_FAILED", "VS Code rejected the workspace edit.");
    this.currentRoot(uri);
    return state(document);
  }

  /**
   * Explicitly saves the requested live document at the expected version.
   * The operation fails if saving leaves the document dirty or changes its version.
   */
  async save(
    { uri: value, version }: SaveInput,
    signal?: AbortSignal,
  ): Promise<DocumentState> {
    signal?.throwIfAborted();
    this.writable();
    const uri = parseUri(value);
    const document = await this.document(uri);
    this.text(document);
    await this.authorize(uri);
    this.writable();
    this.expected(document, version);
    signal?.throwIfAborted();
    if (!(await document.save()))
      fail("SAVE_FAILED", "The document could not be saved.");
    this.currentRoot(uri);
    if (document.version !== version) {
      fail(
        "VERSION_CONFLICT",
        "Document changed during save, possibly through save participants. Read it again.",
      );
    }
    if (document.isDirty)
      fail("SAVE_FAILED", "The document remains dirty after save.");
    return state(document);
  }

  /** Returns bounded editor diagnostics for an admitted workspace URI. */
  async diagnostics({ uri: value }: UriInput): Promise<DiagnosticsResult> {
    const uri = parseUri(value);
    await this.authorize(uri);
    const diagnostics = vscode.languages.getDiagnostics(uri);
    const severity = ["error", "warning", "information", "hint"] as const;
    return {
      uri: uri.toString(),
      truncated: diagnostics.length > MAX_LIST_ENTRIES,
      diagnostics: diagnostics.slice(0, MAX_LIST_ENTRIES).map((item) => ({
        range: range(item.range),
        severity: severity[item.severity] ?? "information",
        message: item.message.slice(0, MAX_SELECTION),
        ...(item.source !== undefined
          ? { source: item.source.slice(0, MAX_PREVIEW) }
          : {}),
        ...(item.code !== undefined
          ? {
              code: typeof item.code === "object" ? item.code.value : item.code,
            }
          : {}),
      })),
    };
  }
}
