import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { transformSync } from "esbuild";
import * as contracts from "../src/types";
import type { WorkspaceService } from "../src/workspace";

/** Minimal URI fixture for deterministic workspace API boundary tests. */
class Uri {
  private constructor(private readonly value: URL) {}
  static from(value: { scheme: string; path: string }): Uri {
    return Uri.parse(`${value.scheme}:${value.path}`);
  }
  static parse(value: string): Uri {
    return new Uri(new URL(value));
  }
  get scheme() {
    return this.value.protocol.slice(0, -1);
  }
  get authority() {
    return this.value.host;
  }
  get path() {
    return this.value.pathname;
  }
  get query() {
    return this.value.search.slice(1);
  }
  get fragment() {
    return this.value.hash.slice(1);
  }
  toString() {
    return this.value.toString();
  }
}

function loadService(vscode: unknown): WorkspaceService {
  const exports = {} as {
    WorkspaceService: new (allow: () => boolean) => WorkspaceService;
  };
  const code = transformSync(readFileSync("src/workspace.ts", "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code;
  const module = { exports };
  runInNewContext(code, {
    module,
    exports,
    require: (id: string) => {
      if (id === "vscode") return vscode;
      if (id === "node:buffer") return { Buffer };
      if (id === "node:crypto") return { randomUUID };
      if (id === "./types") return contracts;
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  return new module.exports.WorkspaceService(() => true);
}

class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
  isAfter(other: Position) {
    return (
      this.line > other.line ||
      (this.line === other.line && this.character > other.character)
    );
  }
}
class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}
class WorkspaceEdit {
  edits: { range: Range; text: string }[] = [];
  replace(_uri: Uri, range: Range, text: string) {
    this.edits.push({ range, text });
  }
}

// Exercise the real formatting and guarded edit path with a minimal VS Code API.
test("format summaries omit large edits without dropping the buffer mutation", async () => {
  const root = Uri.parse("vfs:/project");
  const uri = Uri.parse("vfs:/project/main");
  let text = "messy";
  const replacement = "x".repeat(100_000);
  let supplied = true;
  const document = {
    uri,
    version: 1,
    isDirty: false,
    isClosed: false,
    lineCount: 1,
    getText: () => text,
    offsetAt: (position: Position) => position.character,
    lineAt: () => ({
      text,
      range: new Range(new Position(0, 0), new Position(0, text.length)),
    }),
  };
  const service = loadService({
    Uri,
    Position,
    Range,
    WorkspaceEdit,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: root }],
      textDocuments: [document],
      fs: {
        stat: async (value: Uri) => ({
          type: value.toString() === root.toString() ? 2 : 1,
          size: text.length,
        }),
      },
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      applyEdit: async (edit: WorkspaceEdit) => {
        for (const item of edit.edits)
          text =
            text.slice(0, item.range.start.character) +
            item.text +
            text.slice(item.range.end.character);
        document.version++;
        document.isDirty = true;
        return true;
      },
    },
    commands: {
      executeCommand: async () =>
        supplied
          ? [{ range: document.lineAt().range, newText: replacement }]
          : [],
    },
  });
  try {
    const preview = await service.format({ uri: uri.toString(), version: 1 });
    assert.equal(preview.editCount, 1);
    assert.equal(preview.edits?.[0]?.text, replacement);
    const result = await service.format({
      uri: uri.toString(),
      version: 1,
      apply: true,
    });
    assert.equal(text, replacement);
    assert.equal(result.version, 2);
    assert.equal(result.dirty, true);
    assert.equal(result.applied, true);
    assert.equal(result.editCount, 1);
    assert.equal("edits" in result, false);
    assert.ok(JSON.stringify(result).length < 200);
    assert.ok(JSON.stringify(preview).length > 100_000);
    const included = await service.format({
      uri: uri.toString(),
      version: 2,
      apply: true,
      includeEdits: true,
    });
    assert.equal(included.edits?.[0]?.text, replacement);
    const summary = await service.format({
      uri: uri.toString(),
      version: 3,
      includeEdits: false,
    });
    assert.equal("edits" in summary, false);
    assert.equal(summary.applied, false);
    assert.equal(summary.editCount, 1);
    supplied = false;
    const empty = await service.format({
      uri: uri.toString(),
      version: 3,
      apply: true,
    });
    assert.equal(empty.editCount, 0);
    assert.equal(empty.applied, false);
    assert.equal("edits" in empty, false);
    assert.equal(document.version, 3);
  } finally {
    service.dispose();
  }
});
