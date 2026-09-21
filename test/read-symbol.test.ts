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
  constructor(private readonly value: URL) {}
  static parse(value: string) {
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
const at = (line: number, character = 0) => ({ line, character });
const range = (start: contracts.Position, end: contracts.Position) => ({
  start,
  end,
});
const plain = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

function fixture(text: string, symbols: unknown[] = []) {
  const root = Uri.parse("vfs-test://host/project?tenant=one");
  const uri = Uri.parse("vfs-test://host/project/main.txt?tenant=one");
  const lines = text.split(/\r\n|\n|\r/);
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\n|\r/g))
    starts.push(match.index! + match[0].length);
  let provider = async (): Promise<unknown[] | undefined> => symbols;
  let onStat = () => {};
  let calls = 0;
  const document = {
    uri,
    version: 2,
    isDirty: true,
    isClosed: false,
    languageId: "text",
    lineCount: lines.length,
    lineAt(line: number) {
      return {
        text: lines[line]!,
        range: new Range(
          new Position(line, 0),
          new Position(line, lines[line]!.length),
        ),
      };
    },
    offsetAt(p: contracts.Position) {
      return starts[p.line]! + p.character;
    },
    positionAt(offset: number) {
      let line = starts.length - 1;
      while (starts[line]! > offset) line--;
      return new Position(
        line,
        Math.min(offset - starts[line]!, lines[line]!.length),
      );
    },
    getText(value?: Range) {
      return value
        ? text.slice(this.offsetAt(value.start), this.offsetAt(value.end))
        : text;
    },
  };
  const vscode = {
    Uri,
    Position,
    Range,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    commands: {
      executeCommand: async (command: string, value: Uri) => {
        assert.equal(command, "vscode.executeDocumentSymbolProvider");
        assert.equal(value.toString(), uri.toString());
        calls++;
        return provider();
      },
    },
    workspace: {
      workspaceFolders: [{ uri: root }],
      textDocuments: [document],
      fs: {
        stat: async (value: Uri) => {
          onStat();
          return {
            type: value.path.endsWith(".txt") ? 1 : 2,
            size: text.length,
          };
        },
      },
    },
  };
  const exports = {} as { WorkspaceService: new () => WorkspaceService };
  const module = { exports };
  runInNewContext(
    transformSync(readFileSync("src/workspace.ts", "utf8"), {
      loader: "ts",
      format: "cjs",
    }).code,
    {
      module,
      exports,
      require: (id: string) => {
        if (id === "vscode") return vscode;
        if (id === "node:buffer") return { Buffer };
        if (id === "node:crypto") return { randomUUID };
        if (id === "./types") return contracts;
        throw new Error(`Unexpected import: ${id}`);
      },
    },
  );
  return {
    service: new module.exports.WorkspaceService(),
    document,
    vscode,
    uri: uri.toString(),
    provider(value: () => Promise<unknown[] | undefined>) {
      provider = value;
    },
    onStat(value: () => void) {
      onStat = value;
    },
    calls: () => calls,
  };
}

const symbol = (
  name = "method",
  full = range(at(0), at(2, 1)),
  selection = range(at(0, 9), at(0, 15)),
  children: unknown[] = [],
) => ({
  name,
  kind: 5,
  detail: "",
  range: full,
  selectionRange: selection,
  children,
});
const source = "function method() {\n  work();\n}\nafter";
const request = (f: ReturnType<typeof fixture>) => ({
  uri: f.uri,
  version: 2,
  name: "method",
});

test("read_symbol returns the entire provider body in an admitted virtual live buffer", async () => {
  const f = fixture(source, [symbol()]);
  const result = await f.service.readSymbol(request(f));
  assert.equal(result.text, "function method() {\n  work();\n}");
  assert.equal(result.uri, "vfs-test://host/project/main.txt?tenant=one");
  assert.equal(result.dirty, true);
  assert.equal(result.version, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(plain(result.symbol), {
    name: "method",
    kind: 5,
    range: range(at(0), at(2, 1)),
    selectionRange: range(at(0, 9), at(0, 15)),
  });
  assert.equal(f.calls(), 1);
});

test("duplicate overloads require an exact identifier start, never a body position", async () => {
  const f = fixture("method first\nmethod second", [
    symbol("method", range(at(0), at(0, 12)), range(at(0), at(0, 6))),
    symbol("method", range(at(1), at(1, 13)), range(at(1), at(1, 6))),
  ]);
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "SYMBOL_AMBIGUOUS",
  });
  assert.equal(
    (await f.service.readSymbol({ ...request(f), position: at(1) })).text,
    "method second",
  );
  await assert.rejects(
    f.service.readSymbol({ ...request(f), position: at(1, 2) }),
    { code: "SYMBOL_NOT_FOUND" },
  );
});

test("containerName selects only the exact immediate parent", async () => {
  const f = fixture(source, [
    symbol("Outer", undefined, undefined, [
      symbol("Inner", undefined, undefined, [symbol()]),
      symbol("Other", undefined, undefined, [symbol()]),
    ]),
  ]);
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "SYMBOL_AMBIGUOUS",
  });
  const result = await f.service.readSymbol({
    ...request(f),
    containerName: "Inner",
  });
  assert.equal(result.symbol.containerName, "Inner");
  await assert.rejects(
    f.service.readSymbol({ ...request(f), containerName: "Outer" }),
    { code: "SYMBOL_NOT_FOUND" },
  );
  await assert.rejects(
    f.service.readSymbol({ ...request(f), name: "Method" }),
    { code: "SYMBOL_NOT_FOUND" },
  );
});

test("flat symbols never supply bodies and other-URI locations never match", async () => {
  const f = fixture(source);
  const flat = {
    name: "method",
    kind: 5,
    containerName: "",
    location: { uri: f.document.uri, range: range(at(0, 9), at(0, 15)) },
  };
  f.provider(async () => [flat]);
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "SYMBOL_RANGE_UNAVAILABLE",
  });
  f.provider(async () => [symbol(), flat]);
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "SYMBOL_RANGE_UNAVAILABLE",
  });
  f.provider(async () => [
    {
      ...flat,
      location: {
        ...flat.location,
        uri: Uri.parse("vfs-test://host/project/other.txt?tenant=one"),
      },
    },
  ]);
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "SYMBOL_NOT_FOUND",
  });
  f.provider(async () => undefined);
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "SYMBOL_NOT_FOUND",
  });
});

test("invalid provider full or selection ranges cannot produce a body", async () => {
  const f = fixture(source);
  for (const item of [
    symbol("method", range(at(2), at(0))),
    symbol("method", range(at(0), at(9))),
    symbol("method", undefined, range(at(0), at(3))),
    symbol("method", undefined, range(at(0, 15), at(0, 9))),
    { ...symbol(), range: undefined },
    { ...symbol(), selectionRange: undefined },
  ]) {
    f.provider(async () => [item]);
    await assert.rejects(f.service.readSymbol(request(f)), {
      code: "SYMBOL_RANGE_UNAVAILABLE",
    });
  }
});

test("traversal overflow cannot hide a second candidate or claim no match", async () => {
  const f = fixture(source);
  const unrelated = symbol("unrelated");
  for (const items of [
    [symbol(), ...Array.from({ length: 999 }, () => unrelated), symbol()],
    [
      symbol("parent", undefined, undefined, [
        symbol(),
        ...Array.from({ length: 999 }, () => unrelated),
        symbol(),
      ]),
    ],
    Array.from({ length: 1001 }, () => unrelated),
  ]) {
    f.provider(async () => items);
    await assert.rejects(f.service.readSymbol(request(f)), {
      code: "SYMBOL_RESOLUTION_INCOMPLETE",
    });
  }
  f.provider(async () => [
    symbol(),
    ...Array.from({ length: 999 }, () => unrelated),
  ]);
  assert.equal(
    (await f.service.readSymbol(request(f))).text,
    "function method() {\n  work();\n}",
  );
});

test("provider completion rejects changed, closed and replaced source documents", async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => {
      f.document.version++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.document.isClosed = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.vscode.workspace.textDocuments = [{ ...f.document }];
    },
  ]) {
    const f = fixture(source);
    f.provider(async () => {
      invalidate(f);
      return [symbol()];
    });
    await assert.rejects(f.service.readSymbol(request(f)), {
      code: "VERSION_CONFLICT",
    });
  }
});

test("reopening during the delegated read cannot return a same-version replacement", async () => {
  const f = fixture(source);
  f.provider(async () => {
    f.onStat(() => {
      f.vscode.workspace.textDocuments = [{ ...f.document }];
    });
    return [symbol()];
  });
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "VERSION_CONFLICT",
  });
});

test("long symbol continuation reconstructs only its body with exact residual ranges", async () => {
  const text = "prefix " + "x😀".repeat(6000) + " suffix";
  const end = at(0, 18007);
  const f = fixture(text, [
    symbol("method", range(at(0, 7), end), range(at(0, 7), at(0, 8))),
  ]);
  let startPosition: contracts.Position | undefined;
  let collected = "";
  for (let page = 0; page < 8; page++) {
    const result = await f.service.readSymbol({
      ...request(f),
      startPosition,
      maxChars: 3001,
    });
    assert.deepEqual(
      plain(result.requestedRange),
      range(startPosition ?? at(0, 7), end),
    );
    assert.ok(result.text.length <= 3001);
    assert.ok(!/[\ud800-\udfff]/u.test(result.text));
    collected += result.text;
    if (!result.truncated) break;
    startPosition = plain(result.nextPosition!);
  }
  assert.equal(collected, "x😀".repeat(6000));
  assert.ok(f.calls() > 1);
});

test("continuations must remain within the full body; empty end pages are allowed", async () => {
  const f = fixture("before\nbody\nafter", [
    symbol("method", range(at(1), at(1, 4)), range(at(1), at(1, 2))),
  ]);
  for (const startPosition of [at(0), at(2), at(1, 5), at(-1)])
    await assert.rejects(
      f.service.readSymbol({ ...request(f), startPosition }),
      { code: "INVALID_ARGUMENT" },
    );
  const result = await f.service.readSymbol({
    ...request(f),
    startPosition: at(1, 4),
  });
  assert.equal(result.text, "");
  assert.equal(result.truncated, false);
});

test("required versions and selectors are checked before provider dispatch", async () => {
  const f = fixture(source, [symbol()]);
  for (const input of [
    { version: 0 },
    { version: undefined },
    { name: "" },
    { name: "x".repeat(4097) },
    { containerName: "x".repeat(4097) },
    { position: at(99) },
  ])
    await assert.rejects(
      f.service.readSymbol({
        ...request(f),
        ...input,
      } as contracts.ReadSymbolInput),
      { code: "INVALID_ARGUMENT" },
    );
  await assert.rejects(f.service.readSymbol({ ...request(f), version: 1 }), {
    code: "VERSION_CONFLICT",
  });
  assert.equal(f.calls(), 0);
});

test("provider completion rechecks roots, stop and cancellation", async () => {
  for (const code of ["OUTSIDE_WORKSPACE", "SESSION_STOPPED", "AbortError"]) {
    const f = fixture(source);
    const controller = new AbortController();
    f.provider(async () => {
      if (code === "OUTSIDE_WORKSPACE")
        f.vscode.workspace.workspaceFolders = [];
      if (code === "SESSION_STOPPED") f.service.dispose();
      if (code === "AbortError") controller.abort();
      return [symbol()];
    });
    await assert.rejects(
      f.service.readSymbol(request(f), controller.signal),
      code === "AbortError" ? { name: code } : { code },
    );
  }
});

test("normalized flat symbols with equal full and selection ranges fail closed", async () => {
  const f = fixture(source);
  const identifier = range(at(0, 9), at(0, 15));
  f.provider(async () => [
    {
      ...symbol("method", identifier, identifier),
      location: { uri: f.document.uri, range: identifier },
    },
  ]);
  await assert.rejects(f.service.readSymbol(request(f)), {
    code: "SYMBOL_RANGE_UNAVAILABLE",
  });
});

test("exact position excludes same-name normalized flat candidates at other identifiers", async () => {
  const f = fixture("method first\nmethod second", [
    symbol("method", range(at(0), at(0, 12)), range(at(0), at(0, 6))),
    symbol("method", range(at(1), at(1, 6)), range(at(1), at(1, 6))),
  ]);
  const result = await f.service.readSymbol({ ...request(f), position: at(0) });
  assert.equal(result.text, "method first");
});

test("matching uses full names while returned symbol metadata remains bounded", async () => {
  const name = "m".repeat(1500);
  const containerName = "c".repeat(1500);
  const f = fixture(source, [
    symbol(containerName, undefined, undefined, [symbol(name)]),
  ]);
  const result = await f.service.readSymbol({
    ...request(f),
    name,
    containerName,
  });
  assert.equal(result.symbol.name.length, 1000);
  assert.equal(result.symbol.containerName?.length, 1000);
  assert.equal(result.text, "function method() {\n  work();\n}");
  await assert.rejects(
    f.service.readSymbol({ ...request(f), name: name.slice(0, 1000) }),
    { code: "SYMBOL_NOT_FOUND" },
  );
});

test("exact position excludes an overload with a valid different start and malformed selection end", async () => {
  const good = symbol(
    "method",
    range(at(0), at(0, 12)),
    range(at(0), at(0, 6)),
  );
  for (const end of [at(99), at(0), undefined]) {
    const bad = {
      ...symbol("method", range(at(1), at(1, 13))),
      selectionRange: { start: at(1), end },
    };
    for (const children of [
      [good, bad],
      [bad, good],
    ]) {
      const f = fixture("method first\nmethod second", [
        symbol(
          "Parent",
          range(at(0), at(1, 13)),
          range(at(0), at(0, 6)),
          children,
        ),
      ]);
      const result = await f.service.readSymbol({
        ...request(f),
        containerName: "Parent",
        position: at(0),
      });
      assert.equal(result.text, "method first");
      await assert.rejects(
        f.service.readSymbol({
          ...request(f),
          containerName: "Parent",
          position: at(1),
        }),
        { code: "SYMBOL_RANGE_UNAVAILABLE" },
      );
    }
  }
});

test("unusable overload selection starts still prevent a false unique match", async () => {
  const good = symbol(
    "method",
    range(at(0), at(0, 12)),
    range(at(0), at(0, 6)),
  );
  for (const start of [undefined, at(-1), at(99), at(1, NaN)]) {
    const f = fixture("method first\nmethod second", [
      good,
      {
        ...symbol("method", range(at(1), at(1, 13))),
        selectionRange: { start, end: at(1, 6) },
      },
    ]);
    await assert.rejects(
      f.service.readSymbol({ ...request(f), position: at(0) }),
      {
        code: "SYMBOL_RANGE_UNAVAILABLE",
      },
    );
  }
});
