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

function fixture(text: string) {
  const root = Uri.parse("vfs-test://host/project?tenant=one");
  const uri = Uri.parse("vfs-test://host/project/main.txt?tenant=one");
  const lines = text.split(/\r\n|\n|\r/);
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\n|\r/g))
    starts.push(match.index! + match[0].length);
  let onRead = () => {};
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
      onRead();
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
    workspace: {
      workspaceFolders: [{ uri: root }],
      textDocuments: [document],
      fs: {
        stat: async (value: Uri) => ({
          type: value.path.endsWith(".txt") ? 1 : 2,
          size: text.length,
        }),
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
    onRead(value: () => void) {
      onRead = value;
    },
  };
}

test("read defaults stop at both line and UTF-16 budgets", async () => {
  for (const [text, expected, end] of [
    ["x\n".repeat(300), "x\n".repeat(200), at(200)],
    ["x".repeat(20000), "x".repeat(16000), at(0, 16000)],
  ] as const) {
    const f = fixture(text);
    const result = await f.service.read({ uri: f.uri });
    assert.equal(result.text, expected);
    assert.equal(result.truncated, true);
    assert.deepEqual(plain(result.returnedRange), range(at(0), end));
    assert.deepEqual(plain(result.nextPosition), end);
    assert.equal(result.endLine, f.document.lineCount);
  }
});

test("exact residual pages reconstruct CRLF and astral text without splitting", async () => {
  const source = "abc😀\r\ndef\r\nghi😀j";
  const f = fixture(source);
  const end = at(2, 6);
  let start = at(0, 1);
  let collected = "";
  for (let page = 0; page < source.length; page++) {
    const result = await f.service.read({
      uri: f.uri,
      range: range(start, end),
      version: 2,
      maxLines: 1,
      maxChars: 3,
    });
    assert.deepEqual(plain(result.requestedRange), range(start, end));
    assert.deepEqual(plain(result.returnedRange.start), start);
    assert.equal(result.version, 2);
    assert.ok(result.text.length > 0 && result.text.length <= 3);
    assert.ok(!/[\ud800-\udfff]/u.test(result.text));
    assert.ok(!result.text.endsWith("\r"));
    assert.equal(
      result.text,
      source.slice(
        f.document.offsetAt(result.returnedRange.start),
        f.document.offsetAt(result.returnedRange.end),
      ),
    );
    collected += result.text;
    if (!result.truncated) {
      assert.equal(result.nextPosition, undefined);
      break;
    }
    assert.deepEqual(
      plain(result.nextPosition),
      plain(result.returnedRange.end),
    );
    start = plain(result.nextPosition!);
  }
  assert.equal(collected, source.slice(1));
});

test("line budgets also bound partial first lines and permit larger explicit pages", async () => {
  const f = fixture("abc\r\ndef\r\nghi");
  const result = await f.service.read({
    uri: f.uri,
    range: range(at(0, 2), at(2, 3)),
    maxLines: 1,
  });
  assert.equal(result.text, "c\r\n");
  assert.deepEqual(plain(result.nextPosition), at(1));
  const large = fixture("x\n".repeat(500));
  assert.equal(
    (
      await large.service.read({
        uri: large.uri,
        maxLines: 1000,
        maxChars: 64000,
      })
    ).truncated,
    false,
  );
});

test("empty ranges, empty documents, exact EOF and line-count sentinels are complete", async () => {
  for (const text of ["", "abc", "abc\r\n"]) {
    const f = fixture(text);
    const eof = f.document.lineAt(f.document.lineCount - 1).range.end;
    for (const selectors of [
      { range: range(eof, eof) },
      { startLine: f.document.lineCount },
      { startLine: 0, endLine: 0 },
    ]) {
      const result = await f.service.read({ uri: f.uri, ...selectors });
      assert.equal(result.text, "");
      assert.equal(result.truncated, false);
      assert.equal(result.nextPosition, undefined);
      assert.deepEqual(
        plain(result.returnedRange),
        plain(result.requestedRange),
      );
    }
  }
});

test("read rejects mixed, reversed, out-of-bounds and surrogate-interior ranges and invalid budgets", async () => {
  const f = fixture("a😀\r\nb");
  const invalid = [
    { range: range(at(0), at(1)), startLine: 0 },
    { range: range(at(0), at(1)), endLine: 1 },
    { range: range(at(1), at(0)) },
    { range: range(at(0), at(0, 4)) },
    { range: range(at(0, 2), at(1)) },
    { range: range(at(0), at(0, 2)) },
    { range: range(at(0), at(2)) },
    { range: range(at(-1), at(0)) },
    { startLine: 3 },
    { endLine: 3 },
    { startLine: 1, endLine: 0 },
    { maxLines: 0 },
    { maxLines: 1001 },
    { maxLines: 1.5 },
    { maxChars: 1 },
    { maxChars: 64001 },
    { version: 0 },
  ];
  for (const input of invalid) {
    await assert.rejects(
      f.service.read({ uri: f.uri, ...input }),
      { code: "INVALID_ARGUMENT" },
      JSON.stringify(input),
    );
  }
  await assert.rejects(f.service.read({ uri: f.uri, version: 1 }), {
    code: "VERSION_CONFLICT",
  });
});

test("read rejects changed versions on continuation and rechecks roots before response", async () => {
  const f = fixture("abcdef");
  const first = await f.service.read({ uri: f.uri, maxChars: 2 });
  f.document.version++;
  await assert.rejects(
    f.service.read({
      uri: f.uri,
      version: first.version,
      range: range(first.nextPosition!, first.requestedRange.end),
    }),
    { code: "VERSION_CONFLICT" },
  );
  const removed = fixture("text");
  removed.onRead(() => {
    removed.vscode.workspace.workspaceFolders = [];
  });
  await assert.rejects(removed.service.read({ uri: removed.uri }), {
    code: "OUTSIDE_WORKSPACE",
  });
});
