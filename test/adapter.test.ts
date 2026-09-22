import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";
import { transformSync } from "esbuild";
import type * as vscode from "vscode";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "workspace-mcp-adapter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = (value: URL): vscode.Uri =>
    ({
      scheme: value.protocol.slice(0, -1),
      fsPath: value.protocol === "file:" ? fileURLToPath(value) : "",
      toString: () => value.href,
    }) as vscode.Uri;
  const extensionUri = uri(pathToFileURL(join(root, "extension")));
  const globalStorageUri = uri(pathToFileURL(join(root, "storage")));
  const file = (resource: vscode.Uri) => new URL(resource.toString());
  const local = { mkdirSync: (path: string) => mkdirSync(path) };
  const api = {
    stat: async (resource: vscode.Uri) => {
      try {
        const stat = await fs.lstat(file(resource));
        return {
          type: stat.isSymbolicLink() ? 64 : stat.isDirectory() ? 2 : 1,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw Object.assign(new Error("missing"), { code: "FileNotFound" });
        throw error;
      }
    },
    readFile: (resource: vscode.Uri) => fs.readFile(file(resource)),
    readDirectory: async (resource: vscode.Uri) =>
      (await fs.readdir(file(resource), { withFileTypes: true })).map(
        (entry) => [entry.name, entry.isDirectory() ? 2 : 1],
      ),
    writeFile: (resource: vscode.Uri, bytes: Uint8Array) =>
      fs.writeFile(file(resource), bytes),
    createDirectory: async (resource: vscode.Uri) => {
      await fs.mkdir(file(resource), { recursive: true });
    },
    rename: async (
      source: vscode.Uri,
      target: vscode.Uri,
      options: { overwrite: boolean },
    ) => {
      if (!options.overwrite) {
        try {
          await fs.lstat(file(target));
          throw Object.assign(new Error("exists"), { code: "FileExists" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      try {
        await fs.rename(file(source), file(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY")
          throw Object.assign(new Error("exists"), { code: "FileExists" });
        throw error;
      }
    },
    delete: (resource: vscode.Uri) =>
      fs.rm(file(resource), { recursive: true, force: true }),
  };
  const exports: {
    installAdapter?: typeof import("../src/adapter").installAdapter;
  } = {};
  const module = { exports };
  runInNewContext(
    transformSync(readFileSync("src/adapter.ts", "utf8"), {
      loader: "ts",
      format: "cjs",
    }).code,
    {
      module,
      exports,
      Buffer,
      require: (id: string) => {
        if (id === "node:crypto") return crypto;
        if (id === "node:fs") return local;
        if (id === "vscode")
          return {
            FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
            Uri: {
              joinPath: (base: vscode.Uri, ...parts: string[]) =>
                uri(new URL(parts.join("/"), `${base.toString()}/`)),
            },
            workspace: { fs: api },
          };
        throw new Error(`Unexpected import: ${id}`);
      },
    },
  );
  const bundle = async (version: string) => {
    await fs.mkdir(join(extensionUri.fsPath, "dist"), { recursive: true });
    await fs.writeFile(
      join(extensionUri.fsPath, "dist/stdio.cjs"),
      `console.log(${JSON.stringify(version)});`,
    );
    await fs.writeFile(
      join(extensionUri.fsPath, "dist/THIRD_PARTY_NOTICES.txt"),
      `notices ${version}`,
    );
  };
  await bundle("first");
  return {
    root,
    api,
    local,
    bundle,
    context: { extensionUri, globalStorageUri },
    install: module.exports.installAdapter!,
    launch: (path: string) =>
      execFileSync(process.execPath, [path], { encoding: "utf8" }).trim(),
  };
}

test("the same generated path loads an upgraded bundle after the extension is removed", async (t) => {
  const f = await fixture(t);
  const first = await f.install(f.context);
  assert.equal(f.launch(first), "first");
  await f.bundle("second");
  const second = await f.install(f.context);
  assert.equal(first, second);
  await fs.rm(f.context.extensionUri.fsPath, { recursive: true });
  assert.equal(f.launch(first), "second");
  const entries = await fs.readdir(
    join(f.context.globalStorageUri.fsPath, "adapter-v1"),
  );
  const notices = await Promise.all(
    entries
      .filter((entry) => /^[a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{32}$/.test(entry))
      .map((entry) =>
        fs.readFile(
          join(
            f.context.globalStorageUri.fsPath,
            "adapter-v1",
            entry,
            "THIRD_PARTY_NOTICES.txt",
          ),
          "utf8",
        ),
      ),
  );
  assert.ok(notices.includes("notices second"));
});

test("a failed publication preserves the previous usable adapter", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  const rename = f.api.rename;
  f.api.rename = async (from, to, options) => {
    if (/^[a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{32}$/.test(basename(to.fsPath)))
      throw new Error("disk unavailable");
    return rename(from, to, options);
  };
  await assert.rejects(f.install(f.context), /disk unavailable/);
  assert.equal(f.launch(path), "first");
});

test("concurrent compatible installations leave a complete runnable adapter", async (t) => {
  const f = await fixture(t);
  const paths = await Promise.all([f.install(f.context), f.install(f.context)]);
  assert.equal(paths[0], paths[1]);
  assert.equal(f.launch(paths[0]!), "first");
});

test("concurrent different versions publish complete bundles and a later Start selects its version", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await second.bundle("second");
  const shared = {
    ...second.context,
    globalStorageUri: first.context.globalStorageUri,
  };
  const paths = await Promise.all([
    first.install(first.context),
    second.install(shared),
  ]);
  assert.equal(paths[0], paths[1]);
  assert.ok(["first", "second"].includes(first.launch(paths[0]!)));
  await second.bundle("third");
  assert.equal(await second.install(shared), paths[0]);
  assert.equal(first.launch(paths[0]!), "third");
});

test("modified bundle contents are rejected without replacing the launcher", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  const original = await fs.readFile(path, "utf8");
  const directory = join(f.context.globalStorageUri.fsPath, "adapter-v1");
  const [bundle] = (await fs.readdir(directory)).filter((entry) =>
    /^[a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{32}$/.test(entry),
  );
  await fs.writeFile(join(directory, bundle!, "stdio.cjs"), "changed");
  await assert.rejects(f.install(f.context), /modified/);
  assert.equal(await fs.readFile(path, "utf8"), original);
});

test("a damaged staged bundle never replaces the working generation", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  const write = f.api.writeFile;
  f.api.writeFile = (uri, contents) =>
    write(
      uri,
      basename(uri.fsPath) === "stdio.cjs"
        ? Buffer.from('console.log("damaged");')
        : contents,
    );
  await assert.rejects(f.install(f.context), /modified/);
  assert.equal(f.launch(path), "first");
});

test("cancellation during a staged write cannot publish a later generation", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  let cancelled = false;
  const write = f.api.writeFile;
  f.api.writeFile = async (uri, contents) => {
    await write(uri, contents);
    cancelled = true;
  };
  await assert.rejects(
    f.install(f.context, () => {
      if (cancelled) throw new Error("cancelled");
    }),
    /cancelled/,
  );
  assert.equal(f.launch(path), "first");
});

for (const phase of ["before", "after"] as const)
  test(`cancellation ${phase} the publication rename settles restores the prior adapter`, async (t) => {
    const f = await fixture(t);
    const path = await f.install(f.context);
    await f.bundle("second");
    let cancelled = false;
    const entered = deferred();
    const release = deferred();
    const rename = f.api.rename;
    f.api.rename = async (from, to, options) => {
      if (!basename(from.fsPath).startsWith(".install-"))
        return rename(from, to, options);
      if (phase === "after") await rename(from, to, options);
      entered.resolve();
      await release.promise;
      if (phase === "before") await rename(from, to, options);
    };
    const installing = f.install(f.context, () => {
      if (cancelled) throw new Error("cancelled");
    });
    await entered.promise;
    cancelled = true;
    release.resolve();
    await assert.rejects(installing, /cancelled/);
    assert.equal(f.launch(path), "first");
  });

test("rolling back a cancelled publication preserves another window's same-version installation", async (t) => {
  const first = await fixture(t);
  const path = await first.install(first.context);
  await first.bundle("second");
  const second = await fixture(t);
  await second.bundle("second");
  const shared = {
    ...second.context,
    globalStorageUri: first.context.globalStorageUri,
  };
  let cancelled = false;
  const published = deferred();
  const release = deferred();
  const rename = first.api.rename;
  first.api.rename = async (from, to, options) => {
    await rename(from, to, options);
    if (basename(from.fsPath).startsWith(".install-")) {
      published.resolve();
      await release.promise;
    }
  };
  const installing = first.install(first.context, () => {
    if (cancelled) throw new Error("cancelled");
  });
  await published.promise;
  await second.install(shared);
  cancelled = true;
  release.resolve();
  await assert.rejects(installing, /cancelled/);
  assert.equal(first.launch(path), "second");
});

test("cancellation during staging cleanup also rolls back the publication", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  let cancelled = false;
  const remove = f.api.delete;
  f.api.delete = async (uri) => {
    await remove(uri);
    if (basename(uri.fsPath).startsWith(".install-")) cancelled = true;
  };
  await assert.rejects(
    f.install(f.context, () => {
      if (cancelled) throw new Error("cancelled");
    }),
    /cancelled/,
  );
  assert.equal(f.launch(path), "first");
});

test("cancelled preparation stays unselectable when deletion fails", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  let cancelled = false;
  let orphan = "";
  const rename = f.api.rename;
  f.api.rename = async (from, to, options) => {
    await rename(from, to, options);
    if (basename(from.fsPath).startsWith(".install-")) {
      orphan = to.fsPath;
      cancelled = true;
    }
  };
  f.api.delete = async () => {
    throw new Error("cleanup denied");
  };
  await assert.rejects(
    f.install(f.context, () => {
      if (cancelled) throw new Error("cancelled");
    }),
    /Workspace MCP adapter could not remove unused installation files/,
  );
  assert.ok((await fs.stat(orphan)).isDirectory());
  assert.equal(f.launch(path), "first");
});

test("commit marker failure preserves the previous selected adapter", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  f.local.mkdirSync = () => {
    throw new Error("commit denied");
  };
  await assert.rejects(f.install(f.context), /commit denied/);
  assert.equal(f.launch(path), "first");
});

test("cancellation queued after a synchronous commit does not undo the completed installation", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  let cancelled = false;
  const commit = f.local.mkdirSync;
  f.local.mkdirSync = (marker) => {
    commit(marker);
    queueMicrotask(() => {
      cancelled = true;
    });
  };
  assert.equal(
    await f.install(f.context, () => {
      if (cancelled) throw new Error("cancelled");
    }),
    path,
  );
  assert.equal(cancelled, true);
  assert.equal(f.launch(path), "second");
});

test("launcher and installer ignore marker files and symbolic links", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  const directory = join(f.context.globalStorageUri.fsPath, "adapter-v1");
  const name = `${"f".repeat(16)}-${"f".repeat(64)}-`;
  await fs.writeFile(
    join(directory, `${name}${"f".repeat(32)}.ready`),
    "foreign",
  );
  const outside = join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, join(directory, `${name}${"e".repeat(32)}.ready`));
  assert.equal(f.launch(path), "first");
  await f.bundle("second");
  await f.install(f.context);
  assert.equal(f.launch(path), "second");
});

test("non-file storage is rejected before writing or producing an executable path", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.install({
      ...f.context,
      globalStorageUri: { scheme: "remote" } as vscode.Uri,
    }),
    /local file/,
  );
  await assert.rejects(fs.stat(f.context.globalStorageUri.fsPath), {
    code: "ENOENT",
  });
});

test("foreign launchers and symlinked storage are not overwritten", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await fs.writeFile(path, "foreign file");
  await assert.rejects(f.install(f.context), /unrecognized|modified/);
  assert.equal(await fs.readFile(path, "utf8"), "foreign file");
  await fs.rm(f.context.globalStorageUri.fsPath, { recursive: true });
  const outside = join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, f.context.globalStorageUri.fsPath);
  await assert.rejects(f.install(f.context), /directory|symbolic/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("cancellation after source reads prevents later storage writes", async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  const read = f.api.readFile;
  f.api.readFile = async (uri) => {
    const data = await read(uri);
    cancelled = true;
    return data;
  };
  await assert.rejects(
    f.install(f.context, () => {
      if (cancelled) throw new Error("cancelled");
    }),
    /cancelled/,
  );
  await assert.rejects(fs.stat(f.context.globalStorageUri.fsPath), {
    code: "ENOENT",
  });
});
