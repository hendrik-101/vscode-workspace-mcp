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
  const disk = (value: URL) =>
    new URL(value.href.replace(/^vscode-userdata:/, "file:"));
  const env = { uiKind: 1, remoteName: undefined as string | undefined };
  const uri = (value: URL): vscode.Uri =>
    ({
      scheme: value.protocol.slice(0, -1),
      authority: value.host,
      fsPath: ["file:", "vscode-userdata:"].includes(value.protocol)
        ? fileURLToPath(disk(value))
        : "",
      toString: () => value.href,
    }) as vscode.Uri;
  const extensionUri = uri(pathToFileURL(join(root, "extension")));
  const storageUri = (scheme: string) =>
    uri(
      new URL(
        pathToFileURL(join(root, "storage")).href.replace(
          /^file:/,
          `${scheme}:`,
        ),
      ),
    );
  const globalStorageUri = storageUri("file");
  const file = (resource: vscode.Uri) => disk(new URL(resource.toString()));
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
            UIKind: { Desktop: 1, Web: 2 },
            env,
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
    env,
    storageUri,
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

test("repeated Starts reuse the verified selected bundle without storage writes", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  const directory = join(f.context.globalStorageUri.fsPath, "adapter-v1");
  const before = await fs.readdir(directory);
  const unexpectedWrite = () => {
    throw new Error("unexpected storage mutation");
  };
  f.api.createDirectory = unexpectedWrite;
  f.api.writeFile = unexpectedWrite;
  f.api.rename = unexpectedWrite;
  f.local.mkdirSync = unexpectedWrite;
  for (let start = 0; start < 3; start++)
    assert.equal(await f.install(f.context), path);
  assert.deepEqual(await fs.readdir(directory), before);
  assert.equal(f.launch(path), "first");
});

test("changed notices publish a new bundle even when adapter code is identical", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await fs.writeFile(
    join(f.context.extensionUri.fsPath, "dist/THIRD_PARTY_NOTICES.txt"),
    "updated notices",
  );
  assert.equal(await f.install(f.context), path);
  const directory = join(f.context.globalStorageUri.fsPath, "adapter-v1");
  const selected = (await fs.readdir(directory))
    .filter((entry) => entry.endsWith(".ready"))
    .sort()
    .at(-1)!
    .slice(0, -6);
  assert.equal(
    await fs.readFile(
      join(directory, selected, "THIRD_PARTY_NOTICES.txt"),
      "utf8",
    ),
    "updated notices",
  );
  assert.equal(f.launch(path), "first");
});

test("an older extension selects its bundle again instead of reusing unselected history", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await f.bundle("second");
  await f.install(f.context);
  assert.equal(f.launch(path), "second");
  await f.bundle("first");
  assert.equal(await f.install(f.context), path);
  assert.equal(f.launch(path), "first");
});

test("a missing launcher is restored even when the selected bundle is identical", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  await fs.unlink(path);
  assert.equal(await f.install(f.context), path);
  assert.equal(f.launch(path), "first");
});

test("cancellation during stored bundle verification prevents reuse from succeeding", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  const directory = join(f.context.globalStorageUri.fsPath, "adapter-v1");
  const before = await fs.readdir(directory);
  let cancelled = false;
  const read = f.api.readFile;
  f.api.readFile = async (uri) => {
    const bytes = await read(uri);
    if (
      uri.fsPath.endsWith("/THIRD_PARTY_NOTICES.txt") &&
      uri.fsPath.startsWith(directory)
    )
      cancelled = true;
    return bytes;
  };
  await assert.rejects(
    f.install(f.context, () => {
      if (cancelled) throw new Error("cancelled");
    }),
    /cancelled/,
  );
  assert.deepEqual(await fs.readdir(directory), before);
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

test("desktop userdata storage upgrades the adapter at the existing file-storage path", async (t) => {
  const f = await fixture(t);
  const path = await f.install(f.context);
  assert.equal(f.launch(path), "first");
  f.context.globalStorageUri = f.storageUri("vscode-userdata");
  await f.bundle("second");
  assert.equal(await f.install(f.context), path);
  assert.equal(f.launch(path), "second");
});

for (const host of ["web", "remote"] as const)
  test(`${host} userdata storage is rejected before writing an executable`, async (t) => {
    const f = await fixture(t);
    f.context.globalStorageUri = f.storageUri("vscode-userdata");
    if (host === "web") f.env.uiKind = 2;
    else f.env.remoteName = "ssh-remote";
    await assert.rejects(f.install(f.context), /local file/);
    await assert.rejects(fs.stat(f.context.globalStorageUri.fsPath), {
      code: "ENOENT",
    });
  });

test("userdata storage with an authority is rejected before native path use", async (t) => {
  const f = await fixture(t);
  f.context.globalStorageUri = Object.assign(f.storageUri("vscode-userdata"), {
    authority: "server",
  });
  await assert.rejects(f.install(f.context), /local file/);
  await assert.rejects(fs.stat(f.context.globalStorageUri.fsPath), {
    code: "ENOENT",
  });
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
