import * as vscode from "vscode";

interface Entry extends vscode.FileStat {
  content: Uint8Array;
}

/** A genuine extension-host provider: no local paths or files back these URIs. */
export class MemoryProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this.changes.event;
  private readonly entries = new Map<string, Entry>();
  readonly reads: string[] = [];
  writes = 0;
  refuseWrites = false;

  seed(uri: vscode.Uri, text = "", type = vscode.FileType.File): void {
    const content = new TextEncoder().encode(text);
    this.entries.set(uri.toString(), {
      type,
      ctime: 1,
      mtime: 1,
      size: content.byteLength,
      content,
    });
  }

  stored(uri: vscode.Uri): string {
    return new TextDecoder().decode(this.entry(uri).content);
  }

  private entry(uri: vscode.Uri): Entry {
    const entry = this.entries.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return entry;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { content: _content, ...stat } = this.entry(uri);
    return stat;
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    this.entry(uri);
    const prefix = `${uri.path.replace(/\/$/, "")}/`;
    const result: [string, vscode.FileType][] = [];
    for (const [key, entry] of this.entries) {
      const child = vscode.Uri.parse(key);
      if (
        child.scheme !== uri.scheme ||
        child.authority !== uri.authority ||
        child.query !== uri.query
      )
        continue;
      if (!child.path.startsWith(prefix)) continue;
      const name = child.path.slice(prefix.length);
      if (name && !name.includes("/")) result.push([name, entry.type]);
    }
    return result;
  }

  readFile(uri: vscode.Uri): Uint8Array {
    this.reads.push(uri.toString());
    return this.entry(uri).content.slice();
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void {
    if (this.refuseWrites)
      throw vscode.FileSystemError.NoPermissions("Provider is read-only");
    const existing = this.entries.get(uri.toString());
    if (!existing && !options.create)
      throw vscode.FileSystemError.FileNotFound(uri);
    if (existing && !options.overwrite)
      throw vscode.FileSystemError.FileExists(uri);
    const now = Date.now();
    this.entries.set(uri.toString(), {
      type: vscode.FileType.File,
      ctime: existing?.ctime ?? now,
      mtime: Math.max(now, (existing?.mtime ?? 0) + 1),
      size: content.byteLength,
      content: content.slice(),
    });
    this.writes++;
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): never {
    throw vscode.FileSystemError.NoPermissions();
  }
  dispose(): void {
    this.changes.dispose();
  }
}
