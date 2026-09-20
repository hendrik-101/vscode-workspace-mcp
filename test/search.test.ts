import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import test from "node:test";
import * as contracts from "../src/types";
import type { WorkspaceService } from "../src/workspace";

class Uri {
  constructor(private value: URL) {}
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
    return decodeURIComponent(this.value.pathname);
  }
  get query() {
    return this.value.search.slice(1);
  }
  get fragment() {
    return this.value.hash.slice(1);
  }
  with({ path }: { path: string }) {
    const value = new URL(this.value);
    value.pathname = path;
    return new Uri(value);
  }
  toString() {
    return this.value.toString();
  }
}

function fixture(files: Record<string, string>) {
  const root = Uri.parse("vfs-search://host/project");
  let onRoots: (() => void) | undefined;
  let now = 1;
  let reads = 0;
  let listings = 0;
  const documents = Object.entries(files).map(([name, source]) => ({
    uri: root.with({ path: `${root.path}/${name}` }),
    version: 1,
    isClosed: false,
    get lineCount() {
      return source.split("\n").length;
    },
    getText: () => {
      reads++;
      return source;
    },
    replace(text: string) {
      source = text;
      this.version++;
    },
    lineAt(line: number) {
      const text = source.split("\n")[line]!;
      return { text, range: { end: { line, character: text.length } } };
    },
    positionAt(offset: number) {
      const lines = source.slice(0, offset).split("\n");
      return { line: lines.length - 1, character: lines.at(-1)!.length };
    },
    offsetAt(at: { line: number; character: number }) {
      return (
        source
          .split("\n")
          .slice(0, at.line)
          .reduce((n, s) => n + s.length + 1, 0) + at.character
      );
    },
  }));
  const workspace = {
    workspaceFolders: [{ uri: root }],
    textDocuments: documents,
    onDidChangeWorkspaceFolders: (callback: () => void) => {
      onRoots = callback;
      return { dispose() {} };
    },
    fs: {
      stat: async (uri: Uri) => {
        if (uri.toString() === root.toString()) return { type: 2, size: 0 };
        const document = documents.find(
          (d) => d.uri.toString() === uri.toString(),
        );
        if (!document) throw Error("not found");
        return { type: 1, size: 0 };
      },
      readDirectory: async () => {
        listings++;
        return Object.keys(files).map((name) => [name, 1]);
      },
    },
  };
  const module = {
    exports: {} as { WorkspaceService: new () => WorkspaceService },
  };
  const code = transformSync(readFileSync("src/workspace.ts", "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code;
  runInNewContext(code, {
    module,
    exports: module.exports,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    require: (id: string) => {
      if (id === "vscode")
        return {
          Uri,
          workspace,
          FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
        };
      if (id === "node:crypto") return crypto;
      if (id === "node:buffer") return { Buffer };
      if (id === "./types") return contracts;
      throw Error(id);
    },
  });
  return {
    service: new module.exports.WorkspaceService(),
    root: root.toString(),
    documents,
    workspace,
    advance: () => {
      now += 300001;
    },
    rootsChanged: () => onRoots?.(),
    listings: () => listings,
    reads: () => reads,
  };
}

test("search resumes beyond 100 matches in one live file without duplicate matches", async () => {
  const f = fixture({ "many.txt": "needle ".repeat(251) });
  const input = { uri: f.root, query: "needle" };
  const positions: number[] = [];
  let page = await f.service.search(input);
  assert.ok(page.nextCursor, "bounded search must offer continuation");
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 10);
    positions.push(...page.matches.map((m) => m.character));
    if (!page.nextCursor) break;
    page = await f.service.search({ ...input, cursor: page.nextCursor });
  }
  assert.equal(positions.length, 251);
  assert.equal(new Set(positions).size, 251);
  assert.equal(page.incomplete, false);
  assert.equal(f.listings(), 1);
});

test("search resumes beyond 200 files and keeps file filtering and literal options", async () => {
  const f = fixture(
    Object.fromEntries(
      Array.from({ length: 251 }, (_, n) => [`file${n}.txt`, "nothing"]),
    ),
  );
  const input = { uri: f.root, query: "absent" };
  const first = await f.service.search(input);
  assert.equal(first.filesSearched, 200);
  assert.ok(first.nextCursor);
  const last = await f.service.search({ ...input, cursor: first.nextCursor });
  assert.equal(last.filesSearched, 51);
  assert.equal(last.incomplete, false);
  assert.equal(f.listings(), 1);

  const other = fixture({
    "yes.ts": "before\nNEEDLE needles needle.\nafter",
    "no.txt": "needle",
  });
  const result = await other.service.search({
    uri: other.root,
    query: "needle",
    include: ["*.ts"],
    caseSensitive: false,
    wholeWord: true,
    contextLines: 1,
  });
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0]?.context?.[0]?.text, "before");
  assert.equal(
    (await other.service.search({ uri: other.root, query: "." })).matches
      .length,
    1,
  );
});

test("cursors reject replay, changed options, expiry, root changes and changed live documents", async () => {
  const f = fixture({ "many.txt": "needle ".repeat(5) });
  const input = { uri: f.root, query: "needle", maxResults: 1 };
  let first = await f.service.search(input);
  await assert.rejects(
    f.service.search({ ...input, query: "other", cursor: first.nextCursor }),
  );
  await assert.rejects(
    f.service.search({ ...input, cursor: first.nextCursor }),
  );
  first = await f.service.search(input);
  await f.service.search({ ...input, cursor: first.nextCursor });
  await assert.rejects(
    f.service.search({ ...input, cursor: first.nextCursor }),
  );
  first = await f.service.search(input);
  f.advance();
  await assert.rejects(
    f.service.search({ ...input, cursor: first.nextCursor }),
  );
  first = await f.service.search(input);
  f.rootsChanged();
  await assert.rejects(
    f.service.search({ ...input, cursor: first.nextCursor }),
  );
  first = await f.service.search(input);
  f.documents[0]!.replace("changed needle");
  await assert.rejects(
    f.service.search({ ...input, cursor: first.nextCursor }),
  );
  first = await f.service.search({ ...input, maxResults: 1 });
  f.service.dispose();
  await assert.rejects(
    f.service.search({ ...input, cursor: first.nextCursor }),
  );
});

test("canceled search does no provider work; excessive directory fanout is explicitly terminally incomplete", async () => {
  const f = fixture({ "a.txt": "needle" });
  await assert.rejects(
    f.service.search({ uri: f.root, query: "needle" }, AbortSignal.abort()),
  );
  assert.equal(f.reads(), 0);
  const huge = fixture(
    Object.fromEntries(Array.from({ length: 2100 }, (_, n) => [`f${n}`, ""])),
  );
  let page = await huge.service.search({ uri: huge.root, query: "absent" });
  for (let pages = 0; page.nextCursor; pages++) {
    assert.ok(pages < 20);
    page = await huge.service.search({
      uri: huge.root,
      query: "absent",
      cursor: page.nextCursor,
    });
  }
  assert.equal(page.incomplete, true);
  assert.ok(page.limits?.length);
});

test("cursor storage is bounded and repeated buffer validation reaches a terminal overall budget", async () => {
  const f = fixture({ "many.txt": "needle ".repeat(10) });
  const input = { uri: f.root, query: "needle", maxResults: 1 };
  const oldest = await f.service.search(input);
  for (let i = 0; i < 16; i++) await f.service.search(input);
  await assert.rejects(
    f.service.search({ ...input, cursor: oldest.nextCursor }),
    /expired/,
  );
  const big = fixture({
    "big.txt": "needle ".repeat(200) + "x".repeat(900_000),
  });
  const nextInput = { uri: big.root, query: "needle", maxResults: 1 };
  let page = await big.service.search(nextInput);
  let count = page.matches.length;
  while (page.nextCursor) {
    assert.ok(count < 200);
    page = await big.service.search({ ...nextInput, cursor: page.nextCursor });
    count += page.matches.length;
  }
  assert.ok(count > 50 && count < 100);
  assert.equal(page.incomplete, true);
  assert.ok(page.limits?.includes("totalWork"));
});

test("glob metacharacters stay literal and adversarial wildcard work is bounded", async () => {
  const f = fixture({
    "a.test.ts": "needle",
    "a.ts": "needle",
    "[x].ts": "needle",
  });
  let page = await f.service.search({
    uri: f.root,
    query: "needle",
    include: ["**/*.ts"],
    exclude: ["*.test.ts", "[x].ts"],
  });
  assert.equal(page.matches.length, 1);
  assert.match(page.matches[0]!.uri, /\/a.ts$/);
  const expensive = fixture({ ["a".repeat(8000)]: "needle" });
  page = await expensive.service.search({
    uri: expensive.root,
    query: "needle",
    include: ["*a".repeat(128)],
  });
  assert.equal(page.nextCursor, undefined);
  assert.ok(page.limits?.includes("filterWork"));
});

test("cancellation during a provider await invalidates the consumed page and does not leak partial matches", async () => {
  const f = fixture({ "a.txt": "needle ".repeat(3) });
  const input = { uri: f.root, query: "needle", maxResults: 1 };
  const page = await f.service.search(input);
  const abort = new AbortController();
  const original = f.workspace.fs.stat;
  f.workspace.fs.stat = async (uri: Uri) => {
    abort.abort();
    return original(uri);
  };
  await assert.rejects(
    f.service.search({ ...input, cursor: page.nextCursor }, abort.signal),
  );
  f.workspace.fs.stat = original;
  await assert.rejects(f.service.search({ ...input, cursor: page.nextCursor }));
});

test("official MCP pages preserve search state across stateless authenticated HTTP requests", async (t) => {
  const { startServer } = await import("../src/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const f = fixture({ "a.ts": "NEEDLE needle needle" });
  const server = await startServer(f.service);
  t.after(() => server.close());
  const client = new Client({
    name: "progressive-search-test",
    version: "1.0.0",
  });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }),
  );
  const input = {
    uri: f.root,
    query: "needle",
    include: ["*.ts"],
    caseSensitive: false,
    wholeWord: true,
    contextLines: 1,
    maxResults: 2,
  };
  const first = await client.callTool({
    name: "search_workspace",
    arguments: input,
  });
  const firstResult = (
    first.structuredContent as { result: contracts.SearchResult }
  ).result;
  assert.equal(firstResult.matches.length, 2);
  assert.ok(firstResult.nextCursor);
  const unauthorized = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer wrong",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_workspace",
        arguments: { ...input, cursor: firstResult.nextCursor },
      },
    }),
  });
  assert.equal(unauthorized.status, 401);
  const second = await client.callTool({
    name: "search_workspace",
    arguments: { ...input, cursor: firstResult.nextCursor },
  });
  const secondResult = (
    second.structuredContent as { result: contracts.SearchResult }
  ).result;
  assert.equal(secondResult.matches.length, 1);
  assert.equal(secondResult.matches[0]?.character, 14);
  assert.equal(secondResult.incomplete, false);
  const replay = await client.callTool({
    name: "search_workspace",
    arguments: { ...input, cursor: firstResult.nextCursor },
  });
  assert.equal(replay.isError, true);
  assert.equal(
    (replay.structuredContent as { error: { code: string } }).error.code,
    "SEARCH_INVALIDATED",
  );
});

test("default literal search preserves UTF-16 matching within surrogate pairs", async () => {
  const f = fixture({ "emoji.txt": "😀 needle" });
  const page = await f.service.search({ uri: f.root, query: "\ud83d" });
  assert.equal(page.matches.length, 1);
  assert.equal(page.matches[0]?.character, 0);
});
