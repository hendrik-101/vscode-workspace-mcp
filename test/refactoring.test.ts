import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { transformSync } from "esbuild";
import * as contracts from "../src/types";
import type { WorkspaceService } from "../src/workspace";

class Uri {
  constructor(readonly path: string) {}
  static parse(value: string) {
    return new Uri(value.replace(/^vfs:/, ""));
  }
  scheme = "vfs";
  authority = "";
  query = "";
  fragment = "";
  toString() {
    return `vfs:${this.path}`;
  }
  with(value: { path: string }) {
    return new Uri(value.path);
  }
}
class Position {
  constructor(
    readonly line: number,
    readonly character: number,
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
    readonly start: Position,
    readonly end: Position,
  ) {}
}
const range = new Range(new Position(0, 0), new Position(0, 6));
const code = transformSync(readFileSync("src/workspace.ts", "utf8"), {
  loader: "ts",
  format: "cjs",
}).code;
function fixture() {
  const listeners = new Set<
    (event: {
      document: (typeof documents)[number];
      contentChanges?: readonly unknown[];
    }) => void
  >();
  const closeListeners = new Set<
    (document: (typeof documents)[number]) => void
  >();
  const documents = ["/project/a", "/project/b"].map((path) => ({
    uri: new Uri(path),
    isClosed: false,
    isDirty: true,
    version: 3,
    lineCount: 1,
    lineAt: () => ({ text: "before", range }),
    offsetAt: (position: Position) => position.character,
    getText: (): string => "before",
  }));
  let supplied: () => unknown = () => ({
    entries: () =>
      documents.map((document) => [
        document.uri,
        [{ range, newText: "after" }],
      ]),
  });
  const calls: string[] = [];
  const vscode = {
    Uri,
    Position,
    Range,
    Selection: Range,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      workspaceFolders: [{ uri: new Uri("/project") }],
      textDocuments: documents,
      openTextDocument: async (uri: Uri) =>
        documents.find(
          (document) => document.uri.toString() === uri.toString(),
        )!,
      onDidCloseTextDocument: (
        listener: (document: (typeof documents)[number]) => void,
      ) => {
        closeListeners.add(listener);
        return { dispose: () => closeListeners.delete(listener) };
      },
      onDidChangeTextDocument: (
        listener: (event: {
          document: (typeof documents)[number];
          contentChanges?: readonly unknown[];
        }) => void,
      ) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      fs: {
        stat: async (uri: Uri) => ({
          type:
            uri.path === "/project" ? 2 : uri.path.endsWith("link") ? 65 : 1,
          size: 6,
        }),
      },
      applyEdit: () => {
        throw new Error("Preview must never apply an edit");
      },
    },
    commands: {
      executeCommand: async (command: string) => {
        calls.push(command);
        return supplied();
      },
    },
  };
  const module = {
    exports: {} as { WorkspaceService: new () => WorkspaceService },
  };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === "vscode") return vscode;
      if (id === "node:buffer") return { Buffer };
      if (id === "node:crypto") return { randomUUID };
      if (id === "./types") return contracts;
      throw new Error(id);
    },
  });
  const service = new module.exports.WorkspaceService();
  const input = {
    uri: documents[0]!.uri.toString(),
    version: 3,
    position: { line: 0, character: 0 },
    newName: "after",
  };
  return {
    service,
    input,
    documents,
    calls,
    vscode,
    listeners,
    closeListeners,
    supply(value: () => unknown) {
      supplied = value;
    },
    change(index: number) {
      const document = documents[index]!;
      document.version++;
      listeners.forEach((listener) => listener({ document }));
    },
  };
}
const errorCode = (code: string) => (error: unknown) =>
  error instanceof contracts.WorkspaceError && error.code === code;

test("multi-document previews explicitly refuse automatic application, even with opaque file operations", async () => {
  const f = fixture();
  const result = await f.service.rename(f.input);
  assert.equal(result.preview.documents.length, 2);
  assert.equal(result.preview.documents[1]?.version, 3);
  assert.equal(result.preview.applicable, false);
  assert.equal(result.preview.supported, false);
  assert.equal(result.preview.complete, false);
  assert.equal(result.preview.reasons[0], "OPAQUE_WORKSPACE_EDIT");
  assert.equal(f.listeners.size, 0);
  assert.equal(f.closeListeners.size, 0);
  assert.deepEqual(f.calls, ["vscode.executeDocumentRenameProvider"]);
});
for (const [path, code] of [
  ["/private/secret", "OUTSIDE_WORKSPACE"],
  ["/project/link", "SYMLINK_DENIED"],
]) {
  test(`one ${code} text target rejects the entire rename`, async () => {
    const f = fixture();
    f.supply(() => ({
      entries: () => [
        [f.documents[0]!.uri, [{ range, newText: "safe" }]],
        [new Uri(path!), [{ range, newText: "unsafe" }]],
      ],
    }));
    await assert.rejects(f.service.rename(f.input), errorCode(code!));
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
  });
}
for (const index of [0, 1]) {
  test(`target ${index} changing inside provider rejects all edits`, async () => {
    const f = fixture();
    f.supply(() => {
      f.change(index);
      return {
        entries: () =>
          f.documents.map((document) => [
            document.uri,
            [{ range, newText: "after" }],
          ]),
      };
    });
    await assert.rejects(
      f.service.rename(f.input),
      errorCode("VERSION_CONFLICT"),
    );
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
  });
}
test("code actions retain command/disabled limitations and never execute commands", async () => {
  const f = fixture();
  f.supply(() => [
    {
      title: "Fix",
      edit: {
        entries: () => [[f.documents[0]!.uri, [{ range, newText: "after" }]]],
      },
      command: { command: "danger", arguments: ["secret"] },
      disabled: { reason: "private" },
    },
    { title: "Legacy", command: "legacy" },
  ]);
  const result = await f.service.codeActions({
    uri: f.input.uri,
    version: 3,
    range,
    kind: "quickfix",
  });
  assert.equal(result.actions[0]?.applicable, false);
  assert.ok(result.actions[0]?.reasons.includes("COMMAND_REQUIRED"));
  assert.ok(result.actions[0]?.reasons.includes("DISABLED"));
  assert.ok(result.actions[1]?.reasons.includes("NO_EDIT"));
  assert.doesNotMatch(JSON.stringify(result), /danger|secret|private|legacy/);
  assert.deepEqual(f.calls, ["vscode.executeCodeActionProvider"]);
});
test("overlapping provider edits reject the whole preview", async () => {
  const f = fixture();
  f.supply(() => ({
    entries: () => [
      [
        f.documents[0]!.uri,
        [
          { range, newText: "a" },
          { range, newText: "b" },
        ],
      ],
    ],
  }));
  await assert.rejects(
    f.service.rename(f.input),
    errorCode("INVALID_ARGUMENT"),
  );
});
test("cancellation and stop while provider awaits discard all preview content", async () => {
  for (const stop of [false, true]) {
    const f = fixture();
    const controller = new AbortController();
    f.supply(() => {
      if (stop) f.service.dispose();
      else controller.abort();
      return { entries: () => [] };
    });
    await assert.rejects(
      f.service.rename(f.input, controller.signal),
      stop ? errorCode("SESSION_STOPPED") : { name: "AbortError" },
    );
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
  }
});
test("aggregate edit budget is enforced without returning partial actions", async () => {
  const f = fixture();
  f.supply(() => ({
    entries: () => [
      [f.documents[0]!.uri, [{ range, newText: "x".repeat(256 * 1024) }]],
    ],
  }));
  await assert.rejects(f.service.rename(f.input), errorCode("LIMIT_EXCEEDED"));
});

test("public text projection cannot certify hidden resource operations", async () => {
  const f = fixture();
  // Match WorkspaceEdit's public surface: entries exposes only text edits.
  const edit = {
    size: 1,
    entries: () => [[f.documents[0]!.uri, [{ range, newText: "after" }]]],
  };
  Object.defineProperty(edit, "_allEntries", {
    get() {
      throw new Error("Do not inspect private VS Code fields");
    },
  });
  f.supply(() => edit);
  const result = await f.service.rename(f.input);
  assert.equal(result.preview.supported, false);
  assert.equal(result.preview.complete, false);
  assert.equal(result.preview.documents.length, 1);
});

test("root removal during final authorization discards all preview content", async () => {
  const f = fixture();
  const original = f.vscode.workspace.fs.stat;
  let providerReturned = false;
  f.supply(() => {
    providerReturned = true;
    return { entries: () => [] };
  });
  f.vscode.workspace.fs.stat = async (uri) => {
    const stat = await original(uri);
    if (providerReturned) f.vscode.workspace.workspaceFolders = [];
    return stat;
  };
  await assert.rejects(
    f.service.rename(f.input),
    errorCode("OUTSIDE_WORKSPACE"),
  );
  assert.equal(f.listeners.size, 0);
  assert.equal(f.closeListeners.size, 0);
});

test("cancelled source loading never dispatches a provider", async () => {
  const f = fixture();
  const controller = new AbortController();
  const original = f.vscode.workspace.fs.stat;
  f.vscode.workspace.fs.stat = async (uri) => {
    controller.abort();
    return original(uri);
  };
  await assert.rejects(f.service.rename(f.input, controller.signal), {
    name: "AbortError",
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.closeListeners.size, 0);
});

for (const stop of [false, true]) {
  test(`${stop ? "dispose" : "abort"} releases observers while a provider never settles`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.supply(() => {
      started();
      return new Promise(() => {});
    });
    void f.service.rename(f.input, controller.signal);
    await providerStarted;
    assert.equal(f.listeners.size, 1);
    assert.equal(f.closeListeners.size, 1);
    if (stop) f.service.dispose();
    else controller.abort();
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
    f.change(1);
    f.service.dispose();
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
  });
}

test("change tracking overflow fails closed instead of retaining unbounded URIs", async () => {
  const f = fixture();
  f.supply(() => {
    for (let index = 0; index < 1001; index++) {
      const document = {
        ...f.documents[0]!,
        uri: new Uri(`/project/changed-${index}`),
      };
      f.listeners.forEach((listener) => listener({ document }));
    }
    return { entries: () => [] };
  });
  await assert.rejects(f.service.rename(f.input), errorCode("LIMIT_EXCEEDED"));
  assert.equal(f.listeners.size, 0);
  assert.equal(f.closeListeners.size, 0);
});

test("newly opened source exceeding decoded text limit never dispatches a provider", async () => {
  const f = fixture();
  const source = f.documents[0]!;
  const text = "é".repeat(600_000);
  source.getText = () => text;
  source.lineAt = () => ({
    text,
    range: new Range(new Position(0, 0), new Position(0, text.length)),
  });
  f.vscode.workspace.textDocuments = [];
  await assert.rejects(f.service.rename(f.input), errorCode("LIMIT_EXCEEDED"));
  assert.equal(f.calls.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.closeListeners.size, 0);
});

for (const limit of ["count", "bytes"] as const) {
  test(`initial document snapshot rejects its ${limit} budget before provider dispatch`, async () => {
    const f = fixture();
    let copiedUris = 0;
    const extras = Array.from(
      { length: limit === "count" ? 1000 : 1 },
      (_, index) => {
        const uri = new Uri(
          `/project/${limit === "bytes" ? "é".repeat(131_072) : index}`,
        );
        const stringify = uri.toString.bind(uri);
        uri.toString = () => {
          copiedUris++;
          return stringify();
        };
        return { ...f.documents[0]!, uri };
      },
    );
    f.vscode.workspace.textDocuments = [f.documents[0]!, ...extras];
    await assert.rejects(
      f.service.rename(f.input),
      errorCode("LIMIT_EXCEEDED"),
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
    if (limit === "count") assert.equal(copiedUris, 0);
  });
}

for (const blockedCall of [1, 2, 3, 4, 5, 6]) {
  test(`abort during refactoring stat ${blockedCall} prevents later stats and document opens`, async () => {
    const f = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let statCalls = 0;
    let openCalls = 0;
    const stat = f.vscode.workspace.fs.stat;
    const open = f.vscode.workspace.openTextDocument;
    f.vscode.workspace.textDocuments = [];
    f.vscode.workspace.openTextDocument = async (uri) => {
      openCalls++;
      return open(uri);
    };
    f.vscode.workspace.fs.stat = async (uri) => {
      statCalls++;
      const result = await stat(uri);
      if (statCalls === blockedCall) {
        entered();
        await gate;
      }
      return result;
    };
    f.supply(() => ({
      entries: () => [[f.documents[1]!.uri, [{ range, newText: "after" }]]],
    }));
    const pending = f.service.rename(f.input, controller.signal);
    await started;
    const opensBeforeAbort = openCalls;
    controller.abort();
    release();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(statCalls, blockedCall);
    assert.equal(openCalls, opensBeforeAbort);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
    if (blockedCall <= 2) assert.equal(f.calls.length, 0);
  });
}

test("a target closed and reopened at the same version rejects the provider preview", async () => {
  const f = fixture();
  f.supply(() => {
    const original = f.documents[1]!;
    original.isClosed = true;
    const replacement = {
      ...original,
      isClosed: false,
      getText: () => "change",
    };
    f.vscode.workspace.textDocuments = [f.documents[0]!, replacement];
    return { entries: () => [[original.uri, [{ range, newText: "after" }]]] };
  });
  await assert.rejects(
    f.service.rename(f.input),
    errorCode("VERSION_CONFLICT"),
  );
  assert.equal(f.listeners.size, 0);
  assert.equal(f.closeListeners.size, 0);
});

for (const operation of ["rename", "codeActions"] as const) {
  for (const emitEvent of [false, true]) {
    test(`${operation} refreshes every dirty state after a save during final authorization (${emitEvent ? "dirty event" : "no event"})`, async () => {
      const f = fixture();
      let statCalls = 0;
      const stat = f.vscode.workspace.fs.stat;
      f.vscode.workspace.fs.stat = async (uri) => {
        const result = await stat(uri);
        if (++statCalls === 7) {
          for (const document of f.documents) {
            document.isDirty = false;
            if (emitEvent)
              f.listeners.forEach((listener) =>
                listener({ document, contentChanges: [] }),
              );
          }
        }
        return result;
      };
      const edit = {
        entries: () =>
          f.documents.map((document) => [
            document.uri,
            [{ range, newText: "after" }],
          ]),
      };
      if (operation === "codeActions") f.supply(() => [{ title: "Fix", edit }]);
      else f.supply(() => edit);
      const result =
        operation === "rename"
          ? await f.service.rename(f.input)
          : await f.service.codeActions({
              uri: f.input.uri,
              version: 3,
              range,
              kind: "quickfix",
            });
      const preview = "preview" in result ? result.preview : result.actions[0]!;
      assert.equal(result.dirty, false);
      assert.equal(preview.documents.length, 2);
      assert.ok(
        preview.documents.every(
          (document) => document.dirty === false && document.version === 3,
        ),
      );
    });
  }
}

test("a provider-opened target closed and reopened at the same version invalidates the entire preview", async () => {
  const f = fixture();
  f.vscode.workspace.textDocuments = [f.documents[0]!];
  f.supply(() => {
    const opened = f.documents[1]!;
    f.vscode.workspace.textDocuments.push(opened);
    opened.isClosed = true;
    f.closeListeners.forEach((listener) => listener(opened));
    const replacement = { ...opened, isClosed: false, getText: () => "change" };
    f.vscode.workspace.textDocuments = [f.documents[0]!, replacement];
    return {
      entries: () => [[replacement.uri, [{ range, newText: "after" }]]],
    };
  });
  await assert.rejects(
    f.service.rename(f.input),
    errorCode("VERSION_CONFLICT"),
  );
  assert.equal(f.listeners.size, 0);
  assert.equal(f.closeListeners.size, 0);
});
