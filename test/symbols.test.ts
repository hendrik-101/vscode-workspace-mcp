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
