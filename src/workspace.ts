import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import {
  WorkspaceError,
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

function pathKey(uri: vscode.Uri): string {
  return uri.path.replace(/\/+$/, "") || "/";
}

function contains(root: vscode.Uri, uri: vscode.Uri): boolean {
  const base = pathKey(root);
  const path = pathKey(uri);
  return (
    root.scheme === uri.scheme &&
    root.authority === uri.authority &&
    root.query === uri.query &&
    !uri.fragment &&
    !root.fragment &&
    (path === base || path.startsWith(base === "/" ? "/" : `${base}/`))
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
  if (/%(?:2e|2f|5c|25)/i.test(rawPath) || /%(?![0-9a-f]{2})/i.test(value)) {
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
  constructor(private readonly allowWrites: () => boolean = () => false) {}

  private currentRoot(uri: vscode.Uri): vscode.Uri {
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
    const base = pathKey(root);
    const target = pathKey(uri);
    const remainder =
      target === base
        ? []
        : target.slice(base === "/" ? 1 : base.length + 1).split("/");
    let current = root.with({ path: root.path === "" ? "" : base });
    let stat = await vscode.workspace.fs.stat(current);
    this.stillAllowed(uri, root);
    if (isLink(stat)) fail("SYMLINK_DENIED", "Symbolic links are not allowed.");
    for (const segment of remainder) {
      if ((stat.type & vscode.FileType.Directory) === 0) {
        fail("NOT_A_DIRECTORY", "An ancestor is not a directory.");
      }
      current = current.with({
        path: `${pathKey(current) === "/" ? "" : pathKey(current)}/${segment}`,
      });
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

  async roots(): Promise<RootInfo[]> {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      index: folder.index,
    }));
  }

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
      const child = this.child(uri, name);
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
      /[/\\\u0000-\u001f\u007f]/.test(name)
    ) {
      fail("INVALID_ARGUMENT", "Provider returned an unsafe directory entry.");
    }
    const uri = parent.with({
      path: `${pathKey(parent) === "/" ? "" : pathKey(parent)}/${name}`,
    });
    parseUri(uri.toString());
    this.currentRoot(uri);
    return uri;
  }

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

  async search({
    uri: value,
    query,
    maxResults = MAX_RESULTS,
  }: SearchInput): Promise<SearchResult> {
    if (
      typeof query !== "string" ||
      !query ||
      query.length > MAX_SELECTION ||
      /[\r\n]/.test(query)
    ) {
      fail(
        "INVALID_ARGUMENT",
        "query must be a nonempty single-line literal of at most 4096 characters.",
      );
    }
    integer(maxResults, "maxResults", 1);
    if (maxResults > MAX_RESULTS)
      fail("INVALID_ARGUMENT", "maxResults must not exceed 100.");
    const uri = parseUri(value);
    const initialStat = await this.authorize(uri);
    const result: SearchResult = {
      uri: uri.toString(),
      query,
      matches: [],
      filesSearched: 0,
      truncated: false,
      incomplete: false,
      errors: [],
    };
    const queue: Array<{
      uri: vscode.Uri;
      depth: number;
      type: vscode.FileType;
    }> = [{ uri, depth: 0, type: initialStat.type }];
    let visited = 0;
    let filesVisited = 0;
    let bytes = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor]!;
      if (++visited > MAX_SEARCH_ENTRIES) {
        result.truncated = true;
        break;
      }
      try {
        if ((item.type & vscode.FileType.SymbolicLink) !== 0) {
          fail("SYMLINK_DENIED", "Symbolic link skipped.");
        }
        if ((item.type & vscode.FileType.Directory) !== 0) {
          if (item.depth >= MAX_SEARCH_DEPTH) {
            result.truncated = true;
            continue;
          }
          await this.authorize(item.uri);
          const children = await vscode.workspace.fs.readDirectory(item.uri);
          this.currentRoot(item.uri);
          for (const [name, type] of children) {
            if (queue.length >= MAX_SEARCH_ENTRIES) {
              result.truncated = true;
              break;
            }
            queue.push({
              uri: this.child(item.uri, name),
              depth: item.depth + 1,
              type,
            });
          }
        } else if ((item.type & vscode.FileType.File) !== 0) {
          if (filesVisited >= MAX_SEARCH_FILES) {
            result.truncated = true;
            break;
          }
          filesVisited++;
          const document = await this.document(item.uri);
          const text = this.text(document);
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_SEARCH_BYTES) {
            result.truncated = true;
            break;
          }
          result.filesSearched++;
          let offset = 0;
          while ((offset = text.indexOf(query, offset)) !== -1) {
            if (result.matches.length >= maxResults) {
              result.truncated = true;
              break;
            }
            const at = document.positionAt(offset);
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
            });
            offset += query.length;
          }
          if (
            result.matches.length >= maxResults &&
            cursor < queue.length - 1
          ) {
            result.truncated = true;
            break;
          }
        } else {
          fail("NOT_A_FILE", "Entry has an unsupported file type.");
        }
      } catch (error) {
        // Root changes invalidate the entire result, including already collected text.
        this.currentRoot(uri);
        result.incomplete = true;
        if (result.errors.length < MAX_RESULTS) {
          result.errors.push({
            uri: item.uri.toString(),
            message:
              error instanceof WorkspaceError
                ? error.message
                : "Entry could not be read by the workspace filesystem provider.",
          });
        } else result.truncated = true;
      }
    }
    this.currentRoot(uri);
    result.incomplete ||= result.truncated;
    return result;
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

  async edit({
    uri: value,
    version,
    edits,
  }: EditInput): Promise<DocumentState> {
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
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) fail("EDIT_FAILED", "VS Code rejected the workspace edit.");
    this.currentRoot(uri);
    return state(document);
  }

  async save({ uri: value, version }: SaveInput): Promise<DocumentState> {
    this.writable();
    const uri = parseUri(value);
    const document = await this.document(uri);
    this.text(document);
    await this.authorize(uri);
    this.writable();
    this.expected(document, version);
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
