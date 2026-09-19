import assert from "node:assert/strict";
import * as vscode from "vscode";
import { WorkspaceService } from "../../src/workspace";
import { WorkspaceError, type WorkspaceErrorCode } from "../../src/types";
import { MemoryProvider } from "./memory-provider";

const uri = (value: string): vscode.Uri => vscode.Uri.parse(value);
const range = (start: number, end: number) => ({
  start: { line: 0, character: start },
  end: { line: 0, character: end },
});

async function rejectsCode(
  operation: Promise<unknown>,
  code: WorkspaceErrorCode,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof WorkspaceError && error.code === code,
  );
}

async function updateRoots(
  start: number,
  remove: number,
  additions: Array<{ uri: vscode.Uri; name: string }> = [],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Timed out waiting for workspace folders to change"));
    }, 10_000);
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
    if (!vscode.workspace.updateWorkspaceFolders(start, remove, ...additions)) {
      clearTimeout(timeout);
      subscription.dispose();
      reject(new Error("VS Code refused the test workspace folders"));
    }
  });
}

export async function run(): Promise<void> {
  console.log("VS Code integration: registering virtual providers");
  const provider = new MemoryProvider();
  const readonlyProvider = new MemoryProvider();
  const registration = vscode.workspace.registerFileSystemProvider(
    "vfs-test",
    provider,
    { isCaseSensitive: true },
  );
  const readonlyRegistration = vscode.workspace.registerFileSystemProvider(
    "vfs-test-readonly",
    readonlyProvider,
    { isCaseSensitive: true, isReadonly: true },
  );
  const first = uri("vfs-test://alpha/project");
  const second = uri("vfs-test://beta/project");
  const file = vscode.Uri.joinPath(first, "main.txt");
  const sibling = vscode.Uri.joinPath(second, "main.txt");
  const outside = uri("vfs-test://alpha/project-other/private.txt");
  const link = vscode.Uri.joinPath(first, "escape");
  const linkedFile = vscode.Uri.joinPath(link, "secret.txt");
  const readonlyRoot = uri("vfs-test-readonly://locked/project");
  const readonlyFile = vscode.Uri.joinPath(readonlyRoot, "locked.txt");
  const diagnostics = vscode.languages.createDiagnosticCollection(
    "workspace-mcp-tests",
  );
  const initialRootCount = vscode.workspace.workspaceFolders?.length ?? 0;
  assert.ok(
    initialRootCount > 0 && vscode.workspace.workspaceFile,
    "Launch with a saved .code-workspace to avoid restarting the extension host when adding roots",
  );
  let rootsAdded = false;
  let allowWrites = false;
  const service = new WorkspaceService(() => allowWrites);

  for (const root of [first, second])
    provider.seed(root, "", vscode.FileType.Directory);
  provider.seed(file, "alpha needle\nsecond needle\n");
  provider.seed(sibling, "beta content\n");
  provider.seed(outside, "private material");
  provider.seed(
    link,
    "",
    vscode.FileType.Directory | vscode.FileType.SymbolicLink,
  );
  provider.seed(linkedFile, "linked secret");
  readonlyProvider.seed(readonlyRoot, "", vscode.FileType.Directory);
  readonlyProvider.seed(readonlyFile, "locked content\n");
  readonlyProvider.refuseWrites = true;

  try {
    console.log("VS Code integration: adding virtual workspace roots");
    await updateRoots(initialRootCount, 0, [
      { uri: first, name: "Alpha virtual" },
      { uri: second, name: "Beta virtual" },
      { uri: readonlyRoot, name: "Read-only virtual" },
    ]);
    rootsAdded = true;
    console.log("VS Code integration: reading roots and live buffers");
    assert.equal(
      vscode.workspace.isTrusted,
      true,
      "Write tests require the runner's --disable-workspace-trust flag",
    );

    const roots = await service.roots();
    assert.deepEqual(
      roots.slice(initialRootCount).map((root) => root.uri),
      [first, second, readonlyRoot].map((root) => root.toString()),
    );
    assert.equal(
      (await service.read({ uri: sibling.toString() })).text,
      "beta content\n",
    );
    const listing = await service.list({ uri: first.toString() });
    assert.deepEqual(
      listing.entries.map((entry) => entry.uri),
      [file.toString()],
    );
    assert.equal(listing.blockedEntries, 1);
    assert.equal(listing.truncated, false);

    const initial = await service.read({ uri: file.toString() });
    await rejectsCode(
      service.edit({
        uri: file.toString(),
        version: initial.version,
        edits: [{ range: range(0, 5), text: "blocked" }],
      }),
      "WRITES_DISABLED",
    );
    await rejectsCode(
      service.save({ uri: file.toString(), version: initial.version }),
      "WRITES_DISABLED",
    );
    assert.equal(provider.writes, 0);

    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
    });
    assert.equal(
      await editor.edit((builder) =>
        builder.replace(new vscode.Range(0, 0, 0, 5), "unsaved"),
      ),
      true,
    );
    editor.selection = new vscode.Selection(0, 0, 0, 7);
    const live = await service.read({ uri: file.toString() });
    assert.equal(live.text, "unsaved needle\nsecond needle\n");
    assert.equal(live.dirty, true);
    assert.equal(live.version, document.version);
    assert.equal(provider.stored(file), initial.text);
    assert.equal(
      (await service.read({ uri: file.toString(), startLine: 1, endLine: 2 }))
        .text,
      "second needle\n",
    );
    const context = await service.context();
    assert.equal(context.activeEditor?.uri, file.toString());
    assert.equal(context.activeEditor?.selectedText, "unsaved");
    assert.equal(context.activeEditor?.dirty, true);
    assert.ok(
      context.tabs.some((tab) => tab.uri === file.toString() && tab.dirty),
    );

    const bounded = await service.search({
      uri: file.toString(),
      query: "needle",
      maxResults: 1,
    });
    assert.equal(bounded.matches.length, 1);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.incomplete, true);
    assert.equal(bounded.matches[0]?.character, 8);
    const liveSearch = await service.search({
      uri: file.toString(),
      query: "unsaved",
    });
    assert.equal(liveSearch.matches.length, 1);
    assert.equal(liveSearch.incomplete, false);
    const directorySearch = await service.search({
      uri: first.toString(),
      query: "secret",
    });
    assert.deepEqual(directorySearch.matches, []);
    assert.equal(directorySearch.incomplete, true);
    assert.ok(
      directorySearch.errors.some((error) => error.uri === link.toString()),
    );
    await rejectsCode(
      service.search({
        uri: first.toString(),
        query: "needle",
        maxResults: 101,
      }),
      "INVALID_ARGUMENT",
    );

    allowWrites = true;
    console.log("VS Code integration: validating edits and explicit save");
    await rejectsCode(
      service.edit({
        uri: file.toString(),
        version: initial.version,
        edits: [{ range: range(0, 7), text: "stale" }],
      }),
      "VERSION_CONFLICT",
    );
    await rejectsCode(
      service.edit({
        uri: file.toString(),
        version: live.version,
        edits: [{ range: range(0, 999), text: "invalid" }],
      }),
      "INVALID_ARGUMENT",
    );
    await rejectsCode(
      service.edit({
        uri: file.toString(),
        version: live.version,
        edits: [
          { range: range(0, 4), text: "one" },
          { range: range(3, 6), text: "two" },
        ],
      }),
      "INVALID_ARGUMENT",
    );
    assert.equal(document.getText(), live.text);
    const edited = await service.edit({
      uri: file.toString(),
      version: live.version,
      edits: [{ range: range(0, 7), text: "edited" }],
    });
    assert.equal(edited.dirty, true);
    assert.ok(edited.version > live.version);
    assert.equal(provider.writes, 0, "Editing must never save implicitly");
    assert.equal(provider.stored(file), initial.text);
    await rejectsCode(
      service.save({ uri: file.toString(), version: live.version }),
      "VERSION_CONFLICT",
    );
    const saved = await service.save({
      uri: file.toString(),
      version: edited.version,
    });
    assert.equal(saved.dirty, false);
    assert.equal(provider.stored(file), "edited needle\nsecond needle\n");
    assert.equal(provider.writes, 1);

    console.log("VS Code integration: refusing resource-scoped auto-save");
    // Configure one virtual folder so this also verifies resource-scoped settings.
    provider.seed(
      vscode.Uri.joinPath(first, ".vscode"),
      "",
      vscode.FileType.Directory,
    );
    provider.seed(
      vscode.Uri.joinPath(first, ".vscode", "settings.json"),
      "{}\n",
    );
    const filesConfiguration = vscode.workspace.getConfiguration("files", file);
    const previousAutoSave =
      filesConfiguration.inspect<string>("autoSave")?.workspaceFolderValue;
    try {
      await filesConfiguration.update(
        "autoSave",
        "afterDelay",
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      assert.equal(
        vscode.workspace.getConfiguration("files", file).get("autoSave"),
        "afterDelay",
      );
      assert.equal(
        vscode.workspace.getConfiguration("files", sibling).get("autoSave"),
        "off",
      );
      const backendBefore = provider.stored(file);
      const writesBefore = provider.writes;
      const versionBefore = document.version;
      await rejectsCode(
        service.edit({
          uri: file.toString(),
          version: versionBefore,
          edits: [{ range: range(0, 6), text: "must not auto-save" }],
        }),
        "AUTO_SAVE_ENABLED",
      );
      assert.equal(document.getText(), backendBefore);
      assert.equal(document.version, versionBefore);
      assert.equal(document.isDirty, false);
      assert.equal(
        provider.stored(file),
        backendBefore,
        "Refused edit must leave backend bytes unchanged",
      );
      assert.equal(
        provider.writes,
        writesBefore,
        "Refused edit must not invoke provider writes",
      );
    } finally {
      await filesConfiguration.update(
        "autoSave",
        previousAutoSave,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    }

    console.log("VS Code integration: diagnostics and access boundaries");
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 6),
      "Synthetic diagnostic",
      vscode.DiagnosticSeverity.Warning,
    );
    diagnostic.source = "test-provider";
    diagnostics.set(file, [diagnostic]);
    const reported = await service.diagnostics({ uri: file.toString() });
    assert.equal(reported.diagnostics[0]?.message, "Synthetic diagnostic");
    assert.equal(reported.diagnostics[0]?.severity, "warning");

    for (const rejected of [
      outside.toString(),
      "vfs-test://gamma/project/main.txt",
      `${file.toString()}?different=identity`,
    ]) {
      await rejectsCode(service.read({ uri: rejected }), "OUTSIDE_WORKSPACE");
      await rejectsCode(
        service.diagnostics({ uri: rejected }),
        "OUTSIDE_WORKSPACE",
      );
    }
    for (const traversal of [
      "../private.txt",
      "%2e%2e/private.txt",
      "%252e%252e/private.txt",
      "folder%2f..%2fprivate.txt",
      "folder%5cprivate.txt",
    ]) {
      await rejectsCode(
        service.read({ uri: `${first.toString()}/${traversal}` }),
        "INVALID_ARGUMENT",
      );
    }
    await rejectsCode(
      service.read({ uri: linkedFile.toString() }),
      "SYMLINK_DENIED",
    );
    assert.ok(!provider.reads.includes(linkedFile.toString()));
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(outside),
      { preview: false },
    );
    const outsideContext = await service.context();
    assert.equal(outsideContext.activeEditor, undefined);
    assert.ok(
      !outsideContext.tabs.some((tab) => tab.uri === outside.toString()),
    );

    console.log("VS Code integration: refusing read-only provider writes");
    const locked = await service.read({ uri: readonlyFile.toString() });
    let readonlyFailed = false;
    try {
      const edit = await service.edit({
        uri: readonlyFile.toString(),
        version: locked.version,
        edits: [{ range: range(0, 6), text: "changed" }],
      });
      await service.save({
        uri: readonlyFile.toString(),
        version: edit.version,
      });
    } catch (error) {
      assert.ok(
        error instanceof Error,
        "Read-only provider failure must be explicit",
      );
      readonlyFailed = true;
    }
    assert.ok(
      readonlyFailed,
      "Read-only provider must reject editing or saving",
    );
    assert.equal(readonlyProvider.writes, 0);
    assert.equal(readonlyProvider.stored(readonlyFile), "locked content\n");

    // Root admission is rechecked on every call, even for an already-open document.
    await updateRoots(initialRootCount + 1, 1);
    await rejectsCode(
      service.read({ uri: sibling.toString() }),
      "OUTSIDE_WORKSPACE",
    );
    console.log("VS Code virtual-workspace integration assertions passed.");
    console.log(
      "Workspace Trust refusal is not simulated here: the manifest disables this extension in untrusted workspaces.",
    );
  } finally {
    // Revert dirty test buffers before unregistering their provider to avoid save prompts.
    for (const document of vscode.workspace.textDocuments) {
      if (!document.uri.scheme.startsWith("vfs-test") || !document.isDirty)
        continue;
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (rootsAdded) {
      const count =
        (vscode.workspace.workspaceFolders?.length ?? initialRootCount) -
        initialRootCount;
      if (count > 0) await updateRoots(initialRootCount, count);
    }
    diagnostics.dispose();
    readonlyRegistration.dispose();
    registration.dispose();
    readonlyProvider.dispose();
    provider.dispose();
  }
}
