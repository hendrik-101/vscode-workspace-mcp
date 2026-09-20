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

function fixture(hardDeadlineMs = 25_000) {
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
  const timers = new Map<ReturnType<typeof setTimeout>, number>();
  const emit = (target = uri) =>
    listeners.forEach((listener) => listener({ uris: [target] }));
  let onStat = async () => {};
  const vscode = {
    Uri,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: root }],
      textDocuments: [document],
      fs: {
        stat: async (value: Uri) => {
          await onStat();
          return { type: value.path.endsWith(".txt") ? 1 : 2, size: 1 };
        },
      },
    },
    languages: {
      onDidChangeDiagnostics: (listener: (event: { uris: Uri[] }) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      getDiagnostics: () => [],
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
        if (id === "node:crypto") return { randomUUID };
        if (id === "./types") return contracts;
        throw new Error(`Unexpected import: ${id}`);
      },
    },
  );
  const service = new module.exports.WorkspaceService();
  return {
    service,
    vscode,
    document,
    emit,
    listeners,
    timers,
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
