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

test("exactly 1000 legacy document symbols with 999 denied targets are complete", async () => {
  const root = Uri.parse("vfs-test:/project");
  const file = Uri.parse("vfs-test:/project/main.txt");
  const outside = Uri.parse("vfs-test:/private/secret.txt");
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 6 },
  };
  const document = {
    uri: file,
    version: 1,
    isClosed: false,
    lineCount: 1,
    lineAt: () => ({ range }),
    offsetAt: (position: { character: number }) => position.character,
    getText: () => "source",
  };
  const stats: string[] = [];
  const vscode = {
    Uri,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      workspaceFolders: [{ uri: root }],
      textDocuments: [document],
      fs: {
        stat: async (uri: Uri) => {
          stats.push(uri.toString());
          return { type: uri.toString() === root.toString() ? 2 : 1, size: 6 };
        },
      },
    },
    commands: {
      executeCommand: async (command: string, uri: Uri) => {
        assert.equal(command, "vscode.executeDocumentSymbolProvider");
        assert.equal(uri.toString(), file.toString());
        // Public API supports legacy SymbolInformation[] as well as DocumentSymbol[].
        // Supply that result directly: real VS Code's outline adapter may normalize
        // locations and cache document symbols, so it cannot isolate this boundary.
        return Array.from({ length: 1000 }, (_, index) => ({
          name: `symbol-${index}`,
          kind: 4,
          location: { uri: index === 999 ? file : outside, range },
        }));
      },
    },
  };
  const service = loadService(vscode);
  try {
    const result = await service.documentSymbols({ uri: file.toString() });
    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0]?.name, "symbol-999");
    assert.equal(result.omitted, 999);
    assert.equal(result.truncated, false);
    assert.equal(stats.filter((value) => value === file.toString()).length, 2);
    assert.ok(!stats.includes(outside.toString()));
  } finally {
    service.dispose();
  }
});

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

test("diff completion rechecks a removed comparison root", async () => {
  const leftRoot = Uri.parse("vfs-test:/left");
  const rightRoot = Uri.parse("vfs-test:/right");
  const left = Uri.parse("vfs-test:/left/main.txt");
  const right = Uri.parse("vfs-test:/right/main.txt");
  const end = { line: 0, character: 6 };
  let entered!: () => void;
  let complete!: () => void;
  const commandStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commandFinished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const vscode = {
    Uri,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      workspaceFolders: [{ uri: leftRoot }, { uri: rightRoot }],
      textDocuments: [left, right].map((uri) => ({
        uri,
        isClosed: false,
        lineCount: 1,
        lineAt: () => ({ range: { end } }),
        offsetAt: (position: { character: number }) => position.character,
        getText: () => "source",
      })),
      fs: {
        stat: async (uri: Uri) => ({
          type: uri.path.endsWith(".txt") ? 1 : 2,
          size: 6,
        }),
      },
    },
    commands: {
      executeCommand: async (command: string, first: Uri, second: Uri) => {
        assert.equal(command, "vscode.diff");
        assert.equal(first.toString(), left.toString());
        assert.equal(second.toString(), right.toString());
        entered();
        await commandFinished;
      },
    },
  };
  const service = loadService(vscode);
  const pending = service.diff({
    uri: left.toString(),
    otherUri: right.toString(),
  });
  try {
    await commandStarted;
    // Only the comparison root disappears while the UI command is pending.
    vscode.workspace.workspaceFolders = [{ uri: leftRoot }];
    complete();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof contracts.WorkspaceError &&
        error.code === "OUTSIDE_WORKSPACE",
    );
  } finally {
    complete();
    service.dispose();
  }
});

test("disposed workspace symbol requests do not dispatch language providers", async () => {
  let dispatched = 0;
  const service = loadService({
    commands: {
      executeCommand: async () => {
        dispatched++;
        return [];
      },
    },
  });
  service.dispose();
  await assert.rejects(
    service.workspaceSymbols({ query: "class" }),
    (error: unknown) =>
      error instanceof contracts.WorkspaceError &&
      error.code === "SESSION_STOPPED",
  );
  assert.equal(dispatched, 0);
});

test("pending diff snapshots survive capacity pressure, failures and stop", async () => {
  const root = Uri.parse("vfs-test:/project");
  const file = Uri.parse("vfs-test:/project/main.txt");
  const end = { line: 0, character: 6 };
  let registered = 0;
  let disposed = 0;
  let content!: (uri: Uri) => string;
  const commands: Array<{
    uri: Uri;
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  const vscode = {
    Uri,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    FileSystemError: { FileNotFound: () => new Error("Snapshot expired") },
    workspace: {
      workspaceFolders: [{ uri: root }],
      textDocuments: [
        {
          uri: file,
          isClosed: false,
          lineCount: 1,
          version: 1,
          lineAt: () => ({ range: { end } }),
          offsetAt: (position: { character: number }) => position.character,
          getText: () => "source",
        },
      ],
      fs: {
        stat: async (uri: Uri) => ({
          type: uri.path.endsWith(".txt") ? 1 : 2,
          size: 6,
        }),
      },
      registerTextDocumentContentProvider: (
        _scheme: string,
        provider: { provideTextDocumentContent(uri: Uri): string },
      ) => {
        registered++;
        content = provider.provideTextDocumentContent;
        return {
          dispose: () => {
            disposed++;
          },
        };
      },
    },
    commands: {
      executeCommand: (_command: string, _left: Uri, right: Uri) =>
        new Promise<void>((resolve, reject) => {
          commands.push({ uri: right, resolve, reject });
        }),
    },
  };
  const service = loadService(vscode);
  const pending: Array<Promise<{ shown: boolean }>> = [];
  const start = (text: string) =>
    service.diff({ uri: file.toString(), version: 1, proposedText: text });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    for (let index = 0; index < 8; index++)
      pending.push(start(`proposal-${index}`));
    await tick();
    assert.equal(commands.length, 8);
    assert.equal(registered, 1);
    await assert.rejects(
      start("ninth"),
      (error: unknown) =>
        error instanceof contracts.WorkspaceError &&
        error.code === "LIMIT_EXCEEDED",
    );
    assert.equal(commands.length, 8);
    assert.equal(content(commands[0]!.uri), "proposal-0");
    // Complete one opening; a retry may evict that completed snapshot only.
    commands[1]!.resolve();
    await pending[1];
    const retry = start("retry");
    pending.push(retry);
    await tick();
    assert.equal(commands.length, 9);
    assert.equal(content(commands[0]!.uri), "proposal-0");
    assert.equal(content(commands[8]!.uri), "retry");
    assert.throws(() => content(commands[1]!.uri), /Snapshot expired/);
    // Failed UI commands free both their pending slot and retained contents.
    const failed = assert.rejects(retry, /UI failed/);
    commands[8]!.reject(new Error("UI failed"));
    await failed;
    assert.throws(() => content(commands[8]!.uri), /Snapshot expired/);
    const afterFailure = start("after failure");
    pending.push(afterFailure);
    await tick();
    assert.equal(commands.length, 10);
    const settled = Promise.allSettled(pending);
    service.dispose();
    assert.equal(disposed, 1);
    assert.throws(() => content(commands[0]!.uri), /Snapshot expired/);
    commands.forEach((command) => command.resolve());
    const results = await settled;
    assert.equal(results[0]?.status, "rejected");
    await assert.rejects(
      start("after stop"),
      (error: unknown) =>
        error instanceof contracts.WorkspaceError &&
        error.code === "SESSION_STOPPED",
    );
    assert.equal(registered, 1);
  } finally {
    service.dispose();
    commands.forEach((command) => command.resolve());
    await Promise.allSettled(pending);
  }
});

for (const operation of ["documentSymbols", "format"] as const) {
  test(`${operation} does not dispatch a provider after cancellation during document loading`, async () => {
    const root = Uri.parse("vfs-test:/project");
    const file = Uri.parse("vfs-test:/project/main.txt");
    const end = { line: 0, character: 6 };
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatched = 0;
    const vscode = {
      Uri,
      FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
      workspace: {
        workspaceFolders: [{ uri: root }],
        textDocuments: [
          {
            uri: file,
            isClosed: false,
            version: 1,
            lineCount: 1,
            lineAt: () => ({ range: { end } }),
            offsetAt: (position: { character: number }) => position.character,
            getText: () => "source",
          },
        ],
        getConfiguration: () => ({
          get: (_key: string, fallback: unknown) => fallback,
        }),
        fs: {
          stat: async (uri: Uri) => {
            entered();
            await gate;
            return { type: uri.path.endsWith(".txt") ? 1 : 2, size: 6 };
          },
        },
      },
      commands: {
        executeCommand: async () => {
          dispatched++;
          return [];
        },
      },
    };
    const service = loadService(vscode);
    const controller = new AbortController();
    const pending =
      operation === "documentSymbols"
        ? service.documentSymbols({ uri: file.toString() }, controller.signal)
        : service.format(
            { uri: file.toString(), version: 1 },
            controller.signal,
          );
    try {
      await started;
      controller.abort();
      release();
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(dispatched, 0);
    } finally {
      release();
      service.dispose();
    }
  });
}

function symbolFixture() {
  const file = Uri.parse("vfs-test:/project/main.txt");
  const full = {
    start: { line: 0, character: 0 },
    end: { line: 4, character: 1 },
  };
  const selection = {
    start: { line: 0, character: 3 },
    end: { line: 0, character: 6 },
  };
  const document = {
    uri: file,
    version: 7,
    isClosed: false,
    lineCount: 5,
    lineAt: (line: number) => ({
      range: {
        start: { line, character: 0 },
        end: { line, character: [9, 12, 0, 0, 1][line]! },
      },
    }),
    offsetAt: () => 26,
    getText: () => "class A {\n method() {}\n\n\n}",
  };
  const makeSymbol = (name: string, kind = 5) => ({
    name,
    detail: "",
    kind,
    range: full,
    selectionRange: selection,
    children: [],
  });
  let items: unknown[] = [makeSymbol("method")];
  let providerEffect = () => {};
  const vscode = {
    Uri,
    Location: class {
      constructor(
        public uri: Uri,
        public range: unknown,
      ) {}
    },
    SymbolInformation: class {
      constructor(
        public name: string,
        public kind: number,
        public containerName: string,
        public location: unknown,
      ) {}
    },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      workspaceFolders: [{ uri: Uri.parse("vfs-test:/project") }],
      textDocuments: [document],
      fs: {
        stat: async (uri: Uri) => ({
          type: uri.path.endsWith(".txt") ? 1 : 2,
          size: 25,
        }),
      },
    },
    commands: {
      executeCommand: async () => {
        providerEffect();
        return items;
      },
    },
  };
  return {
    service: loadService(vscode),
    file,
    document,
    full,
    selection,
    vscode,
    makeSymbol,
    setItems: (value: unknown[]) => {
      items = value;
    },
    onProvider: (effect: () => void) => {
      providerEffect = effect;
    },
  };
}

test("document symbols preserve complete and selection ranges separately", async () => {
  const f = symbolFixture();
  try {
    const result = await f.service.documentSymbols({ uri: f.file.toString() });
    assert.equal(result.version, 7);
    assert.equal(result.consistency, "document-version");
    assert.equal(result.symbols[0]?.type, "method");
    assert.equal(result.symbols[0]?.fullRangeKnown, true);
    assert.equal(
      JSON.stringify(result.symbols[0]?.range),
      JSON.stringify(f.full),
    );
    assert.equal(
      JSON.stringify(result.symbols[0]?.selectionRange),
      JSON.stringify(f.selection),
    );
    f.setItems([
      {
        name: "legacy",
        kind: 5,
        location: { uri: f.file, range: f.selection },
      },
    ]);
    const legacy = await f.service.documentSymbols({ uri: f.file.toString() });
    assert.equal(legacy.symbols[0]?.fullRangeKnown, false);
    assert.equal(legacy.symbols[0]?.selectionRange, undefined);
  } finally {
    f.service.dispose();
  }
});

test("document pages bind version and paginate admitted filtered symbols", async () => {
  const f = symbolFixture();
  f.setItems(
    Array.from({ length: 45 }, (_, i) =>
      f.makeSymbol(`Method${i}`, i % 2 ? 4 : 5),
    ),
  );
  try {
    const first = await f.service.documentSymbols({
      uri: f.file.toString(),
      name: "METHOD",
      kind: "method",
    });
    assert.equal(first.symbols.length, 20);
    assert.equal(first.nextOffset, 20);
    const second = await f.service.documentSymbols({
      uri: f.file.toString(),
      name: "METHOD",
      kind: 5,
      offset: first.nextOffset,
      version: first.version,
    });
    assert.equal(
      second.symbols.map((s) => s.name).join(","),
      "Method40,Method42,Method44",
    );
    assert.equal(second.nextOffset, undefined);
    assert.equal(second.truncated, false);
    await assert.rejects(
      f.service.documentSymbols({ uri: f.file.toString(), offset: 20 }),
      { code: "INVALID_ARGUMENT" },
    );
    await assert.rejects(
      f.service.documentSymbols({
        uri: f.file.toString(),
        offset: 20,
        version: 6,
      }),
      { code: "VERSION_CONFLICT" },
    );
  } finally {
    f.service.dispose();
  }
});

for (const change of ["edit", "close", "replace"] as const) {
  test(`document symbol provider-time ${change} rejects stale ranges`, async () => {
    const f = symbolFixture();
    f.onProvider(() => {
      if (change === "edit") f.document.version++;
      if (change === "close") f.document.isClosed = true;
      if (change === "replace")
        f.vscode.workspace.textDocuments = [{ ...f.document }];
    });
    try {
      await assert.rejects(
        f.service.documentSymbols({ uri: f.file.toString() }),
        { code: "VERSION_CONFLICT" },
      );
    } finally {
      f.service.dispose();
    }
  });
}

test("workspace symbol pages disclose live consistency and terminal scan limits", async () => {
  const f = symbolFixture();
  f.setItems(
    Array.from({ length: 1001 }, (_, i) => ({
      name: `item${i}`,
      kind: 5,
      location: { uri: f.file, range: f.selection },
    })),
  );
  try {
    const first = await f.service.workspaceSymbols({ query: "item" });
    assert.equal(first.symbols.length, 20);
    assert.equal(first.consistency, "live");
    assert.equal(first.scanLimitReached, true);
    assert.equal(first.scanned, 1000);
    const last = await f.service.workspaceSymbols({
      query: "item",
      offset: 990,
    });
    assert.equal(last.symbols.length, 10);
    assert.equal(last.nextOffset, undefined);
    assert.equal(last.truncated, true);
    for (const maxResults of [0, 101, 1.5])
      await assert.rejects(
        f.service.workspaceSymbols({ query: "item", maxResults }),
        { code: "INVALID_ARGUMENT" },
      );
  } finally {
    f.service.dispose();
  }
});

test("symbol text budget continues with progress and rejects oversized targets", async () => {
  const f = symbolFixture();
  const longUri = Uri.parse(`vfs-test:/project/${"x".repeat(7000)}.txt`);
  const oversized = Uri.parse(`vfs-test:/project/${"x".repeat(9000)}.txt`);
  f.setItems([
    {
      name: "oversized",
      kind: 5,
      location: { uri: oversized, range: f.selection },
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      name: `${i}-${"n".repeat(1100)}`,
      containerName: "c".repeat(1100),
      kind: 5,
      location: { uri: longUri, range: f.selection },
    })),
  ]);
  try {
    const first = await f.service.workspaceSymbols({
      query: "item",
      maxResults: 100,
    });
    assert.ok(first.symbols.length > 0 && first.symbols.length < 20);
    assert.ok(
      first.symbols.every(
        (s) => s.name.length <= 1000 && s.containerName!.length <= 1000,
      ),
    );
    assert.ok(
      first.symbols.reduce(
        (sum, s) =>
          sum + s.name.length + s.uri.length + (s.containerName?.length ?? 0),
        0,
      ) <= 32768,
    );
    assert.equal(first.omitted, 1);
    assert.equal(first.nextOffset, first.symbols.length);
    const second = await f.service.workspaceSymbols({
      query: "item",
      offset: first.nextOffset,
    });
    assert.notEqual(second.symbols[0]?.name, first.symbols[0]?.name);
  } finally {
    f.service.dispose();
  }
});

test("nested document scans preserve depth-first order and report only actual scan truncation", async () => {
  const f = symbolFixture();
  const parent = {
    ...f.makeSymbol("parent", 4),
    children: Array.from({ length: 999 }, (_, i) => f.makeSymbol(`child${i}`)),
  };
  f.setItems([parent]);
  try {
    const exact = await f.service.documentSymbols({
      uri: f.file.toString(),
      offset: 998,
      version: 7,
    });
    assert.equal(
      exact.symbols.map((s) => s.name).join(","),
      "child997,child998",
    );
    assert.equal(exact.symbols[0]?.containerName, "parent");
    assert.equal(exact.scanned, 1000);
    assert.equal(exact.scanLimitReached, false);
    assert.equal(exact.truncated, false);
    f.setItems([parent, f.makeSymbol("unscanned")]);
    const capped = await f.service.documentSymbols({
      uri: f.file.toString(),
      offset: 998,
      version: 7,
    });
    assert.equal(capped.scanLimitReached, true);
    assert.equal(capped.nextOffset, undefined);
  } finally {
    f.service.dispose();
  }
});

test("document symbols recheck changes during target authorization", async () => {
  const f = symbolFixture();
  let stats = 0;
  const original = f.vscode.workspace.fs.stat;
  f.vscode.workspace.fs.stat = async (uri) => {
    if (++stats === 4) f.document.version++;
    return original(uri);
  };
  try {
    await assert.rejects(
      f.service.documentSymbols({ uri: f.file.toString() }),
      { code: "VERSION_CONFLICT" },
    );
  } finally {
    f.service.dispose();
  }
});

test("normalized legacy document symbols never claim a known body range", async () => {
  const f = symbolFixture();
  // VS Code adapts SymbolInformation into this hierarchical/hybrid shape.
  f.setItems([
    {
      ...f.makeSymbol("legacy"),
      range: f.selection,
      location: { uri: f.file, range: f.selection },
    },
  ]);
  try {
    const result = await f.service.documentSymbols({ uri: f.file.toString() });
    assert.equal(result.symbols[0]?.fullRangeKnown, false);
    assert.equal(
      JSON.stringify(result.symbols[0]?.range),
      JSON.stringify(f.selection),
    );
  } finally {
    f.service.dispose();
  }
});

for (const selection of [
  { start: { line: 0, character: -1 }, end: { line: 0, character: 2 } },
  { start: { line: 0, character: 0.5 }, end: { line: 0, character: 2 } },
  { start: { line: 0, character: 3 }, end: { line: 0, character: 2 } },
  { start: { line: 0, character: 3 }, end: { line: 5, character: 0 } },
]) {
  test(`invalid or uncontained selection ${JSON.stringify(selection)} leaves body range unknown`, async () => {
    const f = symbolFixture();
    f.setItems([{ ...f.makeSymbol("invalid"), selectionRange: selection }]);
    try {
      const result = await f.service.documentSymbols({
        uri: f.file.toString(),
      });
      assert.equal(result.symbols[0]?.fullRangeKnown, false);
    } finally {
      f.service.dispose();
    }
  });
}

for (const invalid of [
  "body-line",
  "body-character",
  "selection-character",
] as const) {
  test(`document bounds reject known full range for ${invalid}`, async () => {
    const f = symbolFixture();
    const symbol = f.makeSymbol("outside-buffer");
    if (invalid === "body-line")
      symbol.range = { ...f.full, end: { line: 5, character: 0 } };
    if (invalid === "body-character")
      symbol.range = { ...f.full, end: { line: 4, character: 2 } };
    if (invalid === "selection-character")
      symbol.selectionRange = {
        ...f.selection,
        end: { line: 0, character: 100 },
      };
    f.setItems([symbol]);
    try {
      const result = await f.service.documentSymbols({
        uri: f.file.toString(),
      });
      assert.equal(result.symbols[0]?.fullRangeKnown, false);
    } finally {
      f.service.dispose();
    }
  });
}

for (const operation of ["documentSymbols", "workspaceSymbols"] as const) {
  test(`${operation} omits malformed names without losing subsequent symbols`, async () => {
    const f = symbolFixture();
    const child = f.makeSymbol("valid-child");
    f.setItems([
      {
        name: undefined,
        kind: 5,
        location: { uri: f.file, range: f.selection },
      },
      { ...f.makeSymbol("invalid-parent"), name: 42, children: [child] },
      {
        name: "valid-last",
        kind: 5,
        location: { uri: f.file, range: f.selection },
      },
    ]);
    try {
      const result =
        operation === "documentSymbols"
          ? await f.service.documentSymbols({
              uri: f.file.toString(),
              name: "valid",
            })
          : await f.service.workspaceSymbols({ query: "valid", name: "valid" });
      assert.equal(result.omitted, operation === "documentSymbols" ? 2 : 3);
      assert.equal(
        result.symbols.map((s) => s.name).join(","),
        operation === "documentSymbols"
          ? "valid-child,valid-last"
          : "valid-last",
      );
      assert.equal(result.scanned, 4);
    } finally {
      f.service.dispose();
    }
  });
}
