import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
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

function diagnostic(index: number, severity = index % 4) {
  return {
    range: {
      start: { line: index, character: 0 },
      end: { line: index, character: 1 },
    },
    severity,
    message: `diagnostic ${index}`,
    source: "test provider",
    code: `code ${index}`,
  };
}

function fixture(hardDeadlineMs = 25_000) {
  const diagnostics: ReturnType<typeof diagnostic>[] = [];
  const uri = Uri.parse("memfs:/project/main.txt");
  const root = Uri.parse("memfs:/project");
  const document = {
    uri,
    version: 4,
    isClosed: false,
    lineCount: 1,
    lineAt: () => ({ range: { end: { line: 0, character: 1 } } }),
    offsetAt: () => 1,
    getText: () => "x",
  };
  const listeners = new Set<(event: { uris: Uri[] }) => void>();
  let registrations = 0;
  const closeListeners = new Set<(document: { uri: Uri }) => void>();
  const timers = new Map<ReturnType<typeof setTimeout>, number>();
  const emit = (target = uri) =>
    listeners.forEach((listener) => listener({ uris: [target] }));
  let onStat = async () => {};
  const opened: Uri[] = [];
  const vscode = {
    Uri,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: root }],
      textDocuments: [document],
      onDidCloseTextDocument: (listener: (document: { uri: Uri }) => void) => {
        closeListeners.add(listener);
        return { dispose: () => closeListeners.delete(listener) };
      },
      openTextDocument: async (uri: Uri) => {
        opened.push(uri);
        return document;
      },
      fs: {
        stat: async (value: Uri) => {
          await onStat();
          return { type: value.path.endsWith(".txt") ? 1 : 2, size: 1 };
        },
      },
    },
    languages: {
      onDidChangeDiagnostics: (listener: (event: { uris: Uri[] }) => void) => {
        registrations++;
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      getDiagnostics: () => diagnostics,
    },
  };
  const module = {
    exports: {} as { WorkspaceService: new () => WorkspaceService },
  };
  runInNewContext(
    transformSync(readFileSync("src/workspace.ts", "utf8"), {
      loader: "ts",
      format: "cjs",
    }).code,
    {
      module,
      exports: module.exports,
      AbortController,
      setTimeout: (callback: () => void, ms: number) => {
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            callback();
          },
          ms === 25_000 ? hardDeadlineMs : ms,
        );
        timers.set(timer, ms);
        return timer;
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        timers.delete(timer);
        clearTimeout(timer);
      },
      require: (id: string) => {
        if (id === "vscode") return vscode;
        if (id === "node:buffer") return { Buffer };
        if (id === "node:crypto") return { createHash, randomUUID };
        if (id === "./types") return contracts;
        throw new Error(`Unexpected import: ${id}`);
      },
    },
  );
  const service = new module.exports.WorkspaceService();
  return {
    service,
    diagnostics,
    vscode,
    document,
    emit,
    listeners,
    closeListeners,
    close: (uri = document.uri) =>
      closeListeners.forEach((listener) => listener({ uri })),
    timers,
    opened,
    registrations: () => registrations,
    setStat: (fn: () => Promise<void>) => {
      onStat = fn;
    },
    wait: (signal?: AbortSignal, timeoutMs = 10) =>
      service.waitForDiagnostics(
        { uri: uri.toString(), version: 4, timeoutMs },
        signal,
      ),
    clean: () => {
      assert.equal(listeners.size, 0);
      assert.equal(closeListeners.size, 0);
      assert.equal(timers.size, 0);
      service.dispose();
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const code = (expected: string) => (error: unknown) =>
  error instanceof contracts.WorkspaceError && error.code === expected;

test("observes a matching event during document authorization without claiming analysis completion", async () => {
  const f = fixture();
  f.setStat(async () => f.emit());
  const result = await f.wait();
  assert.equal(result.outcome, "event_observed");
  assert.equal(result.documentVersion, 4);
  assert.equal(result.analysisComplete, "unknown");
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  assert.equal(result.diagnostics.length, 0);
  f.clean();
});

test("ignores other URIs and returns an honest timeout with empty diagnostics", async () => {
  const f = fixture();
  const pending = f.wait();
  f.emit(Uri.parse("memfs:/project/other.txt"));
  assert.equal((await pending).outcome, "timeout");
  f.clean();
});

test("observes a matching event after entering the wait", async () => {
  const f = fixture();
  const pending = f.wait(undefined, 1000);
  await tick();
  f.emit();
  assert.equal((await pending).outcome, "event_observed");
  f.clean();
});

for (const change of [
  "version",
  "closed",
  "replaced",
  "root",
  "trust",
  "stop",
  "abort",
] as const) {
  test(`rejects ${change} during waiting and cleans up`, async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = f.wait(controller.signal, 1000);
    const expected =
      change === "root"
        ? "OUTSIDE_WORKSPACE"
        : change === "trust"
          ? "UNTRUSTED_WORKSPACE"
          : change === "stop"
            ? "SESSION_STOPPED"
            : "VERSION_CONFLICT";
    const rejected = assert.rejects(
      pending,
      change === "abort" ? { name: "AbortError" } : code(expected),
    );
    await tick();
    if (change === "version") f.document.version++;
    if (change === "closed") f.document.isClosed = true;
    if (change === "replaced")
      f.vscode.workspace.textDocuments = [{ ...f.document }];
    if (change === "root") f.vscode.workspace.workspaceFolders = [];
    if (change === "trust") f.vscode.workspace.isTrusted = false;
    if (change === "stop") f.service.dispose();
    if (change === "abort") controller.abort();
    f.emit();
    await rejected;
    f.clean();
  });
}

test("cancellation during blocked loading disposes immediately, without late listeners or timers", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setStat(() => gate);
  const controller = new AbortController();
  const pending = f.wait(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  f.clean();
  release();
  await tick();
  f.clean();
});

test("stale initial versions and excessive timeouts fail without leaking", async () => {
  const f = fixture();
  f.document.version++;
  await assert.rejects(f.wait(), code("VERSION_CONFLICT"));
  await assert.rejects(f.wait(undefined, 20_001), code("INVALID_ARGUMENT"));
  f.clean();
});

test("hard deadline bounds blocked provider work and releases resources", async () => {
  const f = fixture(10);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setStat(() => gate);
  await assert.rejects(f.wait(), code("LIMIT_EXCEEDED"));
  f.clean();
  release();
  await tick();
  f.clean();
});

test("final authorization catches a version race before diagnostics are exposed", async () => {
  const f = fixture();
  let calls = 0;
  f.setStat(async () => {
    if (++calls === 3) f.document.version++;
  });
  const pending = f.wait();
  f.emit();
  await assert.rejects(pending, code("VERSION_CONFLICT"));
  f.clean();
});

test("a late event during final authorization cannot turn a timeout into event_observed", async () => {
  const f = fixture();
  let calls = 0;
  f.setStat(async () => {
    if (++calls === 3) {
      await tick();
      f.emit();
    }
  });
  assert.equal((await f.wait()).outcome, "timeout");
  f.clean();
});

test("an already-open document replaced at the same version during loading conflicts", async () => {
  const f = fixture();
  let calls = 0;
  f.setStat(async () => {
    if (++calls === 1) {
      f.document.isClosed = true;
      f.vscode.workspace.textDocuments = [{ ...f.document, isClosed: false }];
      f.emit();
    }
  });
  await assert.rejects(f.wait(), code("VERSION_CONFLICT"));
  f.clean();
});

for (const termination of ["abort", "deadline"] as const) {
  for (const blockedStat of [1, 2, 3]) {
    test(`${termination} during stat ${blockedStat} prevents subsequent provider calls`, async () => {
      const f = fixture(termination === "deadline" ? 10 : 25_000);
      if (blockedStat < 3) f.vscode.workspace.textDocuments = [];
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let calls = 0;
      f.setStat(async () => {
        if (++calls === blockedStat) {
          entered();
          await gate;
        }
      });
      const controller = new AbortController();
      const pending = f.wait(controller.signal);
      f.emit();
      await started;
      if (termination === "abort") controller.abort();
      await assert.rejects(
        pending,
        termination === "abort"
          ? { name: "AbortError" }
          : code("LIMIT_EXCEEDED"),
      );
      // Keep the service alive while late provider work completes: stopping it
      // here would mask cancellation bugs with the existing session checks.
      assert.equal(f.listeners.size, 0);
      assert.equal(f.closeListeners.size, 0);
      assert.equal(f.timers.size, 0);
      release();
      await tick();
      assert.equal(calls, blockedStat);
      assert.equal(f.opened.length, 0);
      f.clean();
    });
  }
}

test("cancelled waits retain provider capacity until the pending work actually settles", async () => {
  const f = fixture();
  const releases: Array<() => void> = [];
  f.setStat(() => new Promise<void>((resolve) => releases.push(resolve)));
  const cancelWait = async () => {
    const controller = new AbortController();
    const pending = f.wait(controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
    assert.equal(f.timers.size, 0);
  };
  try {
    for (let index = 0; index < 16; index++) await cancelWait();
    assert.equal(releases.length, 16);
    const excessController = new AbortController();
    const excess = f.wait(excessController.signal);
    const rejected = assert.rejects(excess, code("LIMIT_EXCEEDED"));
    // Abort too, so a missing admission limit fails promptly instead of waiting
    // for the request deadline. Correct admission rejects before any provider.
    excessController.abort();
    await rejected;
    assert.equal(releases.length, 16);
    assert.equal(f.registrations(), 16);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.closeListeners.size, 0);
    assert.equal(f.timers.size, 0);
    releases[0]!();
    await tick();
    await cancelWait();
    assert.equal(releases.length, 17);
  } finally {
    releases.forEach((release) => release());
    await tick();
    f.clean();
  }
});

test("an initially closed URI opened, diagnosed and replaced during authorization conflicts", async () => {
  const f = fixture();
  f.vscode.workspace.textDocuments = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  f.setStat(async () => {
    if (++calls === 1) await gate;
  });
  const pending = f.wait();
  f.vscode.workspace.textDocuments = [f.document];
  f.emit();
  f.document.isClosed = true;
  f.close();
  f.vscode.workspace.textDocuments = [{ ...f.document, isClosed: false }];
  release();
  await assert.rejects(pending, code("VERSION_CONFLICT"));
  f.clean();
});

test("closing an unrelated URI does not invalidate the diagnostic wait", async () => {
  const f = fixture();
  const pending = f.wait();
  f.close(Uri.parse("memfs:/project/unrelated.txt"));
  f.emit();
  assert.equal((await pending).outcome, "event_observed");
  f.clean();
});

test("defaults to a small page and continues without losing diagnostics", async () => {
  const f = fixture();
  f.diagnostics.push(...Array.from({ length: 25 }, (_, i) => diagnostic(i)));
  const input = { uri: f.document.uri.toString() };
  const first = await f.service.diagnostics(input);
  assert.equal(first.diagnostics.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.truncated, true);
  const next = await f.service.diagnostics({
    ...input,
    offset: first.nextOffset,
    snapshotId: first.snapshotId,
  });
  assert.deepEqual(
    Array.from(next.diagnostics, (d) => d.message),
    [
      "diagnostic 20",
      "diagnostic 21",
      "diagnostic 22",
      "diagnostic 23",
      "diagnostic 24",
    ],
  );
  assert.equal(next.nextOffset, undefined);
  assert.equal(next.truncated, false);
  f.clean();
});

test("severity counts cover the inspected source before filtering and pagination", async () => {
  const f = fixture();
  f.diagnostics.push(...Array.from({ length: 1004 }, (_, i) => diagnostic(i)));
  const result = await f.service.diagnostics({
    uri: f.document.uri.toString(),
    severity: "error",
    maxResults: 3,
  });
  assert.deepEqual(
    { ...result.counts },
    { error: 250, warning: 250, information: 250, hint: 250 },
  );
  assert.equal(result.total, 1004);
  assert.equal(result.inspected, 1000);
  assert.equal(result.matching, 250);
  assert.equal(result.incomplete, true);
  assert.deepEqual(
    Array.from(result.diagnostics, (d) => d.message),
    ["diagnostic 0", "diagnostic 4", "diagnostic 8"],
  );
  const empty = await f.service.diagnostics({
    uri: f.document.uri.toString(),
    severity: "error",
    maxResults: 3,
    offset: 250,
    snapshotId: result.snapshotId,
  });
  assert.equal(empty.diagnostics.length, 0);
  assert.equal(empty.truncated, true);
  assert.equal(empty.nextOffset, undefined);
  f.clean();
});

test("clips hostile text within the global budget and every continuation advances", async () => {
  const f = fixture();
  f.diagnostics.push(
    ...Array.from({ length: 24 }, (_, i) => ({
      ...diagnostic(i),
      message: "\u0000".repeat(9000),
      source: "s".repeat(9000),
      code: "c".repeat(9000),
    })),
  );
  let offset = 0;
  let snapshotId: string | undefined;
  do {
    const result = await f.service.diagnostics({
      uri: f.document.uri.toString(),
      maxResults: 100,
      offset,
      snapshotId,
    });
    assert.ok(JSON.stringify(result).length <= 16000);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(
      result.diagnostics.every(
        (d) => d.messageTruncated && d.sourceTruncated && d.codeTruncated,
      ),
    );
    assert.equal(result.truncated, true);
    offset += result.diagnostics.length;
    assert.equal(result.nextOffset, offset < 24 ? offset : undefined);
    snapshotId = result.snapshotId;
  } while (offset < 24);
  f.clean();
});

for (const change of [
  "message",
  "tail",
  "total",
  "range",
  "severity",
  "source",
  "code",
  "filter",
  "page size",
  "uri",
  "version",
  "roots",
  "session",
] as const) {
  test(`continuation rejects changed ${change} binding`, async () => {
    const f = fixture();
    f.diagnostics.push(...Array.from({ length: 30 }, (_, i) => diagnostic(i)));
    const input: contracts.DiagnosticsInput = {
      uri: f.document.uri.toString(),
      maxResults: 3,
    };
    const first = await f.service.diagnostics(input);
    if (change === "message") f.diagnostics[0]!.message = "changed";
    if (change === "tail")
      f.diagnostics[29]!.message = "changed outside first page";
    if (change === "total") f.diagnostics.push(diagnostic(30));
    if (change === "range") f.diagnostics[0]!.range.end.character++;
    if (change === "severity") f.diagnostics[0]!.severity = 3;
    if (change === "source") f.diagnostics[0]!.source = "changed";
    if (change === "code") f.diagnostics[0]!.code = "changed";
    if (change === "filter") input.severity = "warning";
    if (change === "page size") input.maxResults = 4;
    if (change === "uri") input.uri = "memfs:/project/other.txt";
    if (change === "version") f.document.version++;
    if (change === "roots")
      f.vscode.workspace.workspaceFolders.push({
        uri: Uri.parse("memfs:/other"),
      });
    const other = change === "session" ? fixture() : undefined;
    if (other) other.diagnostics.push(...f.diagnostics);
    await assert.rejects(
      (other?.service ?? f.service).diagnostics({
        ...input,
        offset: first.nextOffset,
        snapshotId: first.snapshotId,
      }),
      code("DIAGNOSTICS_CHANGED"),
    );
    other?.clean();
    f.clean();
  });
}

test("rejects invalid pagination before authorization or adding wait listeners", async () => {
  const f = fixture();
  let statCalls = 0;
  f.setStat(async () => {
    statCalls++;
  });
  for (const options of [
    { maxResults: 0 },
    { maxResults: 101 },
    { offset: 1 },
    { offset: -1 },
    { snapshotId: "invalid" },
    { severity: "fatal" },
  ]) {
    const input = {
      uri: f.document.uri.toString(),
      ...options,
    } as contracts.DiagnosticsInput;
    await assert.rejects(
      f.service.diagnostics(input),
      code("INVALID_ARGUMENT"),
    );
    await assert.rejects(
      f.service.waitForDiagnostics({ ...input, version: 4 }),
      code("INVALID_ARGUMENT"),
    );
  }
  assert.equal(statCalls, 0);
  assert.equal(f.registrations(), 0);
  f.clean();
});

test("wait snapshots share filtering, budgets and continuation without changing honesty metadata", async () => {
  const f = fixture();
  f.diagnostics.push(...Array.from({ length: 40 }, (_, i) => diagnostic(i)));
  const input = {
    uri: f.document.uri.toString(),
    maxResults: 3,
    severity: "warning" as const,
  };
  const pending = f.service.waitForDiagnostics({
    ...input,
    version: 4,
    timeoutMs: 1000,
  });
  f.emit();
  const result = await pending;
  assert.equal(result.outcome, "event_observed");
  assert.equal(result.documentVersion, 4);
  assert.equal(result.analysisComplete, "unknown");
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
  assert.equal(result.diagnostics.length, 3);
  assert.equal(result.matching, 10);
  assert.ok(JSON.stringify(result).length <= 16000);
  const next = await f.service.diagnostics({
    ...input,
    offset: result.nextOffset,
    snapshotId: result.snapshotId,
  });
  assert.equal(next.diagnostics[0]!.message, "diagnostic 13");
  f.clean();
});

test("wait output fits with a long URI and heavily escaped diagnostic fields", async () => {
  const f = fixture();
  f.document.uri = Uri.parse(`memfs:/project/${"a".repeat(7600)}.txt`);
  f.diagnostics.push(
    ...Array.from({ length: 2 }, (_, i) => ({
      ...diagnostic(i),
      message: "\u0000".repeat(9000),
      source: "\u0000".repeat(9000),
      code: "\u0000".repeat(9000),
    })),
  );
  const pending = f.service.waitForDiagnostics({
    uri: f.document.uri.toString(),
    version: 4,
    timeoutMs: 1000,
  });
  f.emit(f.document.uri);
  const result = await pending;
  assert.ok(JSON.stringify(result).length <= 16000);
  assert.equal(result.diagnostics.length, 1);
  assert.ok(result.diagnostics[0]!.message.length > 0);
  assert.equal(result.diagnostics[0]!.messageTruncated, true);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.analysisComplete, "unknown");
  f.clean();
});

test("changes beyond clipped text and outside the severity filter invalidate continuation", async () => {
  const f = fixture();
  f.diagnostics.push(
    { ...diagnostic(0, 1), message: "a".repeat(9000) },
    diagnostic(1, 0),
    diagnostic(2, 0),
  );
  const input = {
    uri: f.document.uri.toString(),
    severity: "error" as const,
    maxResults: 1,
  };
  const first = await f.service.diagnostics(input);
  f.diagnostics[0]!.message += "changed clipped tail";
  await assert.rejects(
    f.service.diagnostics({
      ...input,
      offset: first.nextOffset,
      snapshotId: first.snapshotId,
    }),
    code("DIAGNOSTICS_CHANGED"),
  );
  f.clean();
});
