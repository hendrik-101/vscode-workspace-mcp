import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as vscode from "vscode";

const files = ["stdio.cjs", "THIRD_PARTY_NOTICES.txt"] as const;
const commitPattern = /^[a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{32}\.ready$/;
// This immutable launcher reads only its extension-owned directory. Protocol v1
// updates select only committed payloads; leftover preparation is never executable.
const launcher = `// Workspace MCP adapter protocol v1
const { readdirSync } = require("node:fs");
const bundles = readdirSync(__dirname, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9]{16}-[a-f0-9]{64}-[a-f0-9]{32}\\.ready$/.test(entry.name)).map(entry => entry.name.slice(0, -6)).sort();
if (!bundles.length) throw new Error("Run Workspace MCP: Start to install the adapter.");
require("./" + bundles[bundles.length - 1] + "/stdio.cjs");
`;

function contentId(contents: Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const bytes of contents) hash.update(`${bytes.length}:`).update(bytes);
  return hash.digest("hex");
}

async function stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch (error) {
    if ((error as { code?: string }).code === "FileNotFound") return undefined;
    throw error;
  }
}

async function requireType(
  uri: vscode.Uri,
  type: vscode.FileType,
): Promise<void> {
  if ((await stat(uri))?.type !== type)
    throw new Error(
      "Workspace MCP adapter storage contains an unexpected file, directory or symbolic link.",
    );
}

/** Stage extension-owned executable files, never workspace resources or secrets. */
export async function installAdapter(
  context: Pick<vscode.ExtensionContext, "extensionUri" | "globalStorageUri">,
  checkCurrent: () => void = () => {},
): Promise<string> {
  if (context.globalStorageUri.scheme !== "file")
    throw new Error(
      "Workspace MCP adapter requires local file storage on the extension host.",
    );
  const fs = vscode.workspace.fs;
  const join = vscode.Uri.joinPath;
  const storage = context.globalStorageUri;
  const directory = join(storage, "adapter-v1");
  const entry = join(directory, "stdio.cjs");
  const contents = await Promise.all(
    files.map((file) => fs.readFile(join(context.extensionUri, "dist", file))),
  );
  checkCurrent();
  const id = contentId(contents);
  const mutate = async (operation: () => Thenable<unknown>) => {
    checkCurrent();
    await operation();
    checkCurrent();
  };
  for (const uri of [storage, directory]) {
    if (!(await stat(uri))) await mutate(() => fs.createDirectory(uri));
    await requireType(uri, vscode.FileType.Directory);
  }
  const verifyLauncher = async () => {
    if (!(await stat(entry))) return false;
    await requireType(entry, vscode.FileType.File);
    if (Buffer.from(await fs.readFile(entry)).toString("utf8") !== launcher)
      throw new Error(
        "Workspace MCP adapter launcher is unrecognized or modified.",
      );
    return true;
  };
  const verifyBundle = async (uri: vscode.Uri, expected: string) => {
    await requireType(uri, vscode.FileType.Directory);
    const stored = await Promise.all(
      files.map(async (file) => {
        const resource = join(uri, file);
        await requireType(resource, vscode.FileType.File);
        return fs.readFile(resource);
      }),
    );
    if (contentId(stored) !== expected)
      throw new Error("Workspace MCP adapter bundle was modified.");
  };
  const hasLauncher = await verifyLauncher();
  const bundles = (await fs.readDirectory(directory))
    .filter(
      ([name, type]) =>
        type === vscode.FileType.Directory && commitPattern.test(name),
    )
    .map(([name]) => name.slice(0, -6))
    .sort();
  const latest = bundles.at(-1);
  if (latest) await verifyBundle(join(directory, latest), latest.slice(17, 81));
  const revision = latest ? BigInt(`0x${latest.slice(0, 16)}`) + 1n : 1n;
  if (revision > 0xffffffffffffffffn)
    throw new Error("Workspace MCP adapter storage revision limit reached.");
  const owner = randomUUID().replaceAll("-", "");
  const name = `${revision.toString(16).padStart(16, "0")}-${id}-${owner}`;
  const destination = join(directory, name);
  const marker = join(directory, `${name}.ready`);
  // UUID names avoid ordinary concurrent window collisions. Public VS Code fs
  // cannot exclude races with malicious same-user processes (outside our boundary).
  const stage = join(directory, `.install-${randomUUID()}`);
  const stagedEntry = join(directory, `.launcher-${randomUUID()}`);
  const cleanup: vscode.Uri[] = [];
  const removeUnused = async (uri: vscode.Uri) => {
    try {
      await fs.delete(uri, { recursive: true });
    } catch (error) {
      if ((error as { code?: string }).code !== "FileNotFound")
        throw new Error(
          "Workspace MCP adapter could not remove unused installation files. See the adapter storage cleanup instructions.",
        );
    }
  };
  let prepared = false;
  try {
    try {
      if (await stat(stage))
        throw new Error("Workspace MCP adapter staging collision.");
      checkCurrent();
      cleanup.push(stage);
      await mutate(() => fs.createDirectory(stage));
      for (const [index, file] of files.entries())
        await mutate(() => fs.writeFile(join(stage, file), contents[index]!));
      await verifyBundle(stage, id);
      // This destination remains unselectable until its marker is committed.
      // Keep it unique so cleanup cannot remove another window's preparation.
      checkCurrent();
      await fs.rename(stage, destination, { overwrite: false });
      // Record ownership before checking cancellation after an in-flight rename.
      prepared = true;
      checkCurrent();
      await verifyBundle(destination, id);
      if (!hasLauncher) {
        if (await stat(stagedEntry))
          throw new Error("Workspace MCP adapter staging collision.");
        checkCurrent();
        cleanup.push(stagedEntry);
        await mutate(() => fs.writeFile(stagedEntry, Buffer.from(launcher)));
        try {
          await mutate(() =>
            fs.rename(stagedEntry, entry, { overwrite: false }),
          );
        } catch (error) {
          if ((error as { code?: string }).code !== "FileExists") throw error;
        }
        await verifyLauncher();
      }
    } finally {
      await Promise.all(cleanup.map(removeUnused));
    }
    // Cleanup also awaits provider operations, so cancellation can arrive there.
    const adapterPath = entry.fsPath;
    const markerPath = marker.fsPath;
    checkCurrent();
    // Sole commit point: one exclusive synchronous mkdir on guarded local,
    // extension-owned storage. Stop cannot interleave with it; no awaits or
    // cancellation checks follow a successful commit. Existing markers are never
    // overwritten. Workspace resources always remain on the public VS Code API.
    mkdirSync(markerPath);
    return adapterPath;
  } catch (error) {
    // Even when this cleanup fails, an uncommitted payload cannot be selected.
    if (prepared) await removeUnused(destination);
    throw error;
  }
}
