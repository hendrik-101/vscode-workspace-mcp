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
  const exports = {} as { WorkspaceService: new () => WorkspaceService };
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
  return new module.exports.WorkspaceService();
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
  contains(other: Range) {
    return !this.start.isAfter(other.start) && !other.end.isAfter(this.end);
  }
}
function fixture() {
  const root = Uri.parse("vfs-test://host/project?tenant=one");
  const file = Uri.parse("vfs-test://host/project/main.txt?tenant=one");
  const target = Uri.parse("vfs-test://host/project/target.txt?tenant=one");
  const full = new Range(new Position(0, 0), new Position(0, 6));
  const documents = [file, target].map((uri) => ({
    uri,
    version: 2,
    isDirty: true,
    isClosed: false,
    lineCount: 1,
    lineAt: () => ({ text: "source", range: full }),
    offsetAt: (p: Position) => p.character,
    getText: () => "source",
  }));
  let commandResult: unknown = [];
  let onCommand = () => {};
  const calls: string[] = [];
  const listeners = new Set<
    (event: {
      document: (typeof documents)[number];
      contentChanges: unknown[];
    }) => void
  >();
  const vscode = {
    Uri,
    Position,
    Range,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      onDidChangeTextDocument: (
        listener: (event: {
          document: (typeof documents)[number];
          contentChanges: unknown[];
        }) => void,
      ) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      workspaceFolders: [{ uri: root }],
      textDocuments: documents,
      fs: {
        stat: async (uri: Uri) => ({
          type: uri.path.endsWith(".txt") ? 1 : 2,
          size: 6,
        }),
      },
    },
    commands: {
      executeCommand: async (command: string, uri: Uri, position: Position) => {
        calls.push(command);
        assert.equal(uri.toString(), file.toString());
        assert.equal(position.character, 1);
        onCommand();
        return commandResult;
      },
    },
  };
  return {
    service: loadService(vscode),
    vscode,
    documents,
    calls,
    listeners,
    change(document = documents[1]!) {
      document.version++;
      listeners.forEach((listener) =>
        listener({ document, contentChanges: [{}] }),
      );
    },
    file,
    target,
    full,
    input: {
      uri: file.toString(),
      position: { line: 0, character: 1 },
      version: 2,
    },
    result(value: unknown) {
      commandResult = value;
    },
    onCommand(value: () => void) {
      onCommand = value;
    },
  };
}
test("navigation normalizes links and locations, preserves identity and omits denied/invalid targets", async () => {
  const f = fixture();
  f.result([
    { uri: f.target, range: f.full },
    {
      targetUri: f.target,
      targetRange: f.full,
      targetSelectionRange: new Range(new Position(0, 1), new Position(0, 2)),
    },
    { uri: Uri.parse("vfs-test://host/private.txt?tenant=one"), range: f.full },
    { uri: f.target, range: new Range(new Position(0, 0), new Position(0, 7)) },
  ]);
  const result = await f.service.definition(f.input);
  assert.equal(result.locations.length, 2);
  assert.equal(result.omitted, 2);
  assert.equal(result.locations[0]?.uri, f.target.toString());
  assert.equal(result.locations[0]?.version, 2);
  assert.equal(result.locations[0]?.dirty, true);
  assert.equal(result.locations[1]?.range.start.character, 1);
  assert.deepEqual(f.calls, ["vscode.executeDefinitionProvider"]);
});
test("references are bounded and optional versions and exact positions are checked before dispatch", async () => {
  const f = fixture();
  f.result(
    Array.from({ length: 101 }, () => ({ uri: f.target, range: f.full })),
  );
  const result = await f.service.references(f.input);
  assert.equal(result.locations.length, 100);
  assert.equal(result.truncated, true);
  await assert.rejects(f.service.references({ ...f.input, version: 1 }), {
    code: "VERSION_CONFLICT",
  });
  await assert.rejects(
    f.service.references({ ...f.input, position: { line: 0, character: 7 } }),
    { code: "INVALID_ARGUMENT" },
  );
  assert.deepEqual(f.calls, ["vscode.executeReferenceProvider"]);
});
test("hover strips trust and commands metadata, bounds text, and validates ranges", async () => {
  const f = fixture();
  f.result([
    {
      contents: [
        { value: "[link](command:unsafe)", isTrusted: true, supportHtml: true },
      ],
      range: f.full,
    },
    { contents: ["x".repeat(20000)] },
  ]);
  const result = await f.service.hover(f.input);
  assert.equal(result.untrusted, true);
  assert.equal(result.truncated, true);
  assert.equal(result.hovers[0]?.contents[0], "[link](command:unsafe)");
  assert.equal(result.hovers.flatMap((h) => h.contents).join("").length, 16384);
  assert.equal(JSON.stringify(result).includes("isTrusted"), false);
});
for (const operation of ["definition", "references", "hover"] as const) {
  test(`${operation} rejects cancellation, source changes, removed roots, and stopped sessions`, async () => {
    for (const scenario of ["abort", "version", "root", "stop"] as const) {
      const f = fixture();
      const controller = new AbortController();
      f.onCommand(() => {
        if (scenario === "abort") controller.abort();
        if (scenario === "version") f.documents[0]!.version++;
        if (scenario === "root") f.vscode.workspace.workspaceFolders = [];
        if (scenario === "stop") f.service.dispose();
      });
      await assert.rejects(f.service[operation](f.input, controller.signal));
    }
  });
}

test("target edits during provider execution omit old ranges, including newly opened documents", async () => {
  for (const newlyOpened of [false, true]) {
    const f = fixture();
    const target = f.documents[1]!;
    if (newlyOpened) f.documents.pop();
    f.result([{ uri: f.target, range: f.full }]);
    f.onCommand(() => {
      if (newlyOpened) f.documents.push(target);
      f.change(target);
    });
    const result = await f.service.definition(f.input);
    assert.equal(result.locations.length, 0);
    assert.equal(result.omitted, 1);
    assert.equal(f.listeners.size, 0);
  }
});

test("repeated invalid locations validate a target buffer only once per version", async () => {
  const f = fixture();
  let reads = 0;
  f.documents[1]!.getText = () => {
    reads++;
    return "source";
  };
  f.result(
    Array.from({ length: 1000 }, () => ({
      uri: f.target,
      range: new Range(new Position(0, 0), new Position(0, 7)),
    })),
  );
  const result = await f.service.references(f.input);
  assert.equal(result.omitted, 1000);
  assert.ok(reads <= 2, `target full-text reads: ${reads}`);
});

test("final states reflect saves during later target authorization", async () => {
  const f = fixture();
  const third = Uri.parse("vfs-test://host/project/third.txt?tenant=one");
  f.documents.push({ ...f.documents[1]!, uri: third });
  const stat = f.vscode.workspace.fs.stat;
  f.vscode.workspace.fs.stat = async (uri) => {
    if (uri.toString() === third.toString()) {
      f.documents[0]!.isDirty = false;
      f.documents[1]!.isDirty = false;
    }
    return stat(uri);
  };
  f.result([
    { uri: f.target, range: f.full },
    { uri: third, range: f.full },
  ]);
  const result = await f.service.definition(f.input);
  assert.equal(result.dirty, false);
  assert.equal(result.locations[0]?.dirty, false);
});

test("abort and stop dispose navigation observers even when the command never settles", async () => {
  for (const stop of [false, true]) {
    const f = fixture();
    f.vscode.commands.executeCommand = () => new Promise(() => {});
    const controller = new AbortController();
    void f.service.definition(f.input, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.listeners.size, 1);
    if (stop) f.service.dispose();
    else controller.abort();
    assert.equal(f.listeners.size, 0);
  }
});
