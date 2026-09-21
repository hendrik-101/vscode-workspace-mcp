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

function fixture(files: Record<string, string>, json?: typeof JSON) {
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
    ...(json ? { JSON: json } : {}),
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
    assert.ok(pages < 30);
    positions.push(...page.matches.map((m) => m.character));
    if (!page.nextCursor) break;
    page = await f.service.search({ ...input, cursor: page.nextCursor });
  }
  assert.equal(positions.length, 251);
  assert.equal(new Set(positions).size, 251);
  assert.equal(page.incomplete, false);
  assert.equal(f.listings(), 1);
});

test("listing pages unchanged virtual directories without duplicates and rejects changed listings", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 123 }, (_, n) => [`file${n}.txt`, ""]),
  );
  const f = fixture(files);
  let page = await f.service.list({ uri: f.root });
  assert.equal(page.entries.length, 50);
  const firstCursor = page.nextCursor;
  const names = page.entries.map((entry) => entry.name);
  while (page.nextCursor) {
    page = await f.service.list({ uri: f.root, cursor: page.nextCursor });
    names.push(...page.entries.map((entry) => entry.name));
  }
  assert.equal(names.length, 123);
  assert.equal(new Set(names).size, 123);
  assert.equal(page.incomplete, false);
  files["changed.txt"] = "";
  await assert.rejects(
    f.service.list({ uri: f.root, cursor: firstCursor }),
    /changed|invalid/i,
  );
  delete files["file0.txt"];
  await assert.rejects(
    f.service.list({ uri: f.root, cursor: firstCursor }),
    /changed|invalid/i,
  );
});

test("listing bounds serialized pages and distinguishes terminal scan omissions", async () => {
  const f = fixture(
    Object.fromEntries(
      Array.from({ length: 1002 }, (_, n) => [
        `${n}-${"x".repeat(500)}.txt`,
        "",
      ]),
    ),
  );
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.service.list({
      uri: f.root,
      maxEntries: 100,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(JSON.stringify({ result: page }).length <= 16000);
    assert.equal(page.omittedEntries, 2);
    assert.equal(page.incomplete, true);
    assert.ok(page.entries.length > 0);
    names.push(...page.entries.map((entry) => entry.name));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(names.length, 1000);
  assert.equal(new Set(names).size, 1000);
});

test("listing validates page sizes and binds continuation to URI, options and roots", async () => {
  const f = fixture({ "one.txt": "", "two.txt": "" });
  for (const maxEntries of [0, 101, 1.5])
    await assert.rejects(f.service.list({ uri: f.root, maxEntries }));
  const page = await f.service.list({ uri: f.root, maxEntries: 1 });
  await assert.rejects(
    f.service.list({ uri: f.root, cursor: page.nextCursor }),
  );
  f.workspace.workspaceFolders.push({
    uri: Uri.parse("vfs-search://host/another"),
  });
  await assert.rejects(
    f.service.list({ uri: f.root, maxEntries: 1, cursor: page.nextCursor }),
  );
});

test("listing rejects altered offsets and cursors issued by another service", async () => {
  const files = { "one.txt": "", "two.txt": "", "three.txt": "" };
  const f = fixture(files);
  const input = { uri: f.root, maxEntries: 1 };
  const first = await f.service.list(input);
  assert.ok(first.nextCursor);
  for (const offset of ["0", "2", "01"])
    await assert.rejects(
      f.service.list({
        ...input,
        cursor: first.nextCursor.replace(/^\d+/, offset),
      }),
      /invalid/i,
    );
  await assert.rejects(
    fixture(files).service.list({ ...input, cursor: first.nextCursor }),
    /invalid/i,
  );
  const second = await f.service.list({ ...input, cursor: first.nextCursor });
  assert.equal(second.entries[0]?.name, "two.txt");
});

test("listing bounds fingerprint serialization before handling giant provider names", async () => {
  const boundedJson = Object.create(JSON) as typeof JSON;
  boundedJson.stringify = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) => {
      assert.ok(
        typeof item !== "string" || item.length <= 8192,
        "oversized provider names must not reach JSON serialization",
      );
      return item;
    });
  const f = fixture({}, boundedJson);
  let giantName = "x".repeat(1024 * 1024);
  f.workspace.fs.readDirectory = async () => [
    ["first.txt", 1],
    [giantName, 1],
    ["last.txt", 1],
  ];
  const input = { uri: f.root, maxEntries: 1 };
  const first = await f.service.list(input);
  assert.equal(first.entries[0]?.name, "first.txt");
  assert.equal(first.omittedEntries, 1);
  assert.ok(first.nextCursor);
  const last = await f.service.list({ ...input, cursor: first.nextCursor });
  assert.equal(last.entries[0]?.name, "last.txt");
  assert.equal(last.omittedEntries, 1);
  assert.equal(last.incomplete, true);
  assert.equal(last.nextCursor, undefined);
  giantName += "y";
  await assert.rejects(
    f.service.list({ ...input, cursor: first.nextCursor }),
    /invalid/i,
  );
  giantName = "returnable.txt";
  await assert.rejects(
    f.service.list({ ...input, cursor: first.nextCursor }),
    /invalid/i,
  );
});

test("listing reports blocked and oversized entries without stalling continuation", async () => {
  const f = fixture({ "safe.txt": "" });
  f.workspace.fs.readDirectory = async () => [
    ["bad/name", 1],
    ["link", 65],
    ["x".repeat(9000), 1],
    ["safe.txt", 1],
  ];
  const page = await f.service.list({ uri: f.root, maxEntries: 1 });
  assert.equal(page.entries[0]?.name, "safe.txt");
  assert.equal(page.blockedEntries, 2);
  assert.equal(page.omittedEntries, 1);
  assert.equal(page.incomplete, true);
  assert.equal(page.nextCursor, undefined);
});

test("search defaults to twenty matches while honoring explicit counts", async () => {
  const f = fixture({ "many.txt": "x\n".repeat(120) });
  assert.equal(
    (await f.service.search({ uri: f.root, query: "x" })).matches.length,
    20,
  );
  assert.equal(
    (await f.service.search({ uri: f.root, query: "x", maxResults: 100 }))
      .matches.length,
    100,
  );
});

test("search output budget resumes the exact next match with long context and URIs", async () => {
  const name = `${"a".repeat(7600)}.txt`;
  const f = fixture({
    [name]: Array.from({ length: 35 }, () => `needle ${"x".repeat(1200)}`).join(
      "\n",
    ),
  });
  const input = {
    uri: f.documents[0]!.uri.toString(),
    query: "needle",
    maxResults: 100,
    contextLines: 5,
  };
  const lines: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.service.search({
      ...input,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(JSON.stringify({ result: page }).length <= 24000);
    assert.ok(page.matches.length > 0, "every continued page must progress");
    lines.push(...page.matches.map((match) => match.line));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(
    lines,
    Array.from({ length: 35 }, (_, n) => n),
  );
});

test("search skips oversized files while retaining later matches", async () => {
  const f = fixture({
    "large.txt": "x".repeat(1024 * 1024 + 1),
    "small.txt": "needle",
  });
  const page = await f.service.search({ uri: f.root, query: "needle" });
  assert.equal(page.matches.length, 1);
  assert.equal(page.incomplete, true);
  assert.equal(page.errors.length, 1);
});

test("search bounds large provider errors and leaves room for a first match", async () => {
  const names = Array.from(
    { length: 4 },
    (_, n) => `${n}-${"x".repeat(7600)}.txt`,
  );
  const f = fixture(Object.fromEntries(names.map((name) => [name, "needle"])));
  for (const document of f.documents.slice(0, 3)) document.isClosed = true;
  const page = await f.service.search({
    uri: f.root,
    query: "needle",
    contextLines: 5,
  });
  assert.ok(JSON.stringify({ result: page }).length <= 24000);
  assert.equal(page.matches.length, 1);
  assert.equal(page.incomplete, true);
  assert.ok(page.limits?.includes("errors"));
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
  const f = fixture({ "a.ts": "NEEDLE needle needle", "b.ts": "" });
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
  const advertised = (await client.listTools()).tools;
  const listingSchema = advertised.find(
    (tool) => tool.name === "list_directory",
  )!.inputSchema.properties!;
  const searchSchema = advertised.find(
    (tool) => tool.name === "search_workspace",
  )!.inputSchema.properties!;
  assert.match(
    (listingSchema.maxEntries as { description: string }).description ?? "",
    /default 50/,
  );
  assert.match(
    (listingSchema.cursor as { description: string }).description ?? "",
    /nextCursor/,
  );
  assert.match(
    (searchSchema.maxResults as { description: string }).description ?? "",
    /default 20/,
  );
  const listing = await client.callTool({
    name: "list_directory",
    arguments: { uri: f.root, maxEntries: 1 },
  });
  const listingResult = (
    listing.structuredContent as { result: contracts.ListResult }
  ).result;
  assert.equal(listingResult.entries[0]?.name, "a.ts");
  assert.ok(listingResult.nextCursor);
  const listed = await client.callTool({
    name: "list_directory",
    arguments: { uri: f.root, maxEntries: 1, cursor: listingResult.nextCursor },
  });
  const listedResult = (
    listed.structuredContent as { result: contracts.ListResult }
  ).result;
  assert.equal(listedResult.entries[0]?.name, "b.ts");
  assert.equal(listedResult.nextCursor, undefined);
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

test("search saturation preserves a continuation for retry after provider work settles", async () => {
  const f = fixture({ "many.txt": "needle needle needle" });
  const input = { uri: f.root, query: "needle", maxResults: 1 };
  const first = await f.service.search(input);
  assert.ok(first.nextCursor);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.workspace.fs.stat;
  let entered = 0;
  f.workspace.fs.stat = async (uri: Uri) => {
    entered++;
    await blocked;
    return original(uri);
  };
  const running = Array.from({ length: 16 }, () =>
    f.service.search({ uri: f.root, query: "absent" }),
  );
  try {
    assert.equal(entered, 16);
    await assert.rejects(
      f.service.search({ ...input, cursor: first.nextCursor }),
      (error: unknown) =>
        error instanceof contracts.WorkspaceError &&
        error.code === "LIMIT_EXCEEDED",
    );
    assert.equal(entered, 16, "rejected request must not begin provider work");
  } finally {
    release();
    await Promise.all(running);
    f.workspace.fs.stat = original;
  }
  const resumed = await f.service.search({
    ...input,
    cursor: first.nextCursor,
  });
  assert.equal(resumed.matches.length, 1);
  assert.equal(resumed.matches[0]?.character, 7);
});
