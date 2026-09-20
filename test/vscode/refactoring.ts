import assert from "node:assert/strict";
import * as vscode from "vscode";
import { WorkspaceService } from "../../src/workspace";
import { WorkspaceError } from "../../src/types";
import { MemoryProvider } from "./memory-provider";

/** Real extension-host dispatch; synthetic providers do not establish SAP behavior. */
export async function refactoringTools(
  provider: MemoryProvider,
  first: vscode.Uri,
  second: vscode.Uri,
  outside: vscode.Uri,
  linked: vscode.Uri,
): Promise<void> {
  const file = vscode.Uri.joinPath(first, "refactoring.txt");
  const other = vscode.Uri.joinPath(second, "refactoring.txt");
  provider.seed(file, "before");
  provider.seed(other, "before");
  const document = await vscode.workspace.openTextDocument(file);
  const sibling = await vscode.workspace.openTextDocument(other);
  const service = new WorkspaceService();
  const selector = { scheme: "vfs-test", pattern: "**/refactoring.txt" };
  const range = new vscode.Range(0, 0, 0, 6);
  let target = other;
  let commandRuns = 0;
  let mutate = false;
  const registrations = [
    vscode.commands.registerCommand(
      "workspaceMcp.testNeverExecute",
      () => commandRuns++,
    ),
    vscode.languages.registerRenameProvider(selector, {
      async provideRenameEdits() {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(file, range, "after");
        edit.replace(target, range, "after");
        // Resource operations are not inspectable through entries(), even mixed
        // with ordinary text edits. Never apply this projection or the original.
        edit.deleteFile(target);
        if (mutate) {
          const change = new vscode.WorkspaceEdit();
          change.insert(other, new vscode.Position(0, 0), "x");
          await vscode.workspace.applyEdit(change);
        }
        return edit;
      },
    }),
    vscode.languages.registerCodeActionsProvider(selector, {
      provideCodeActions() {
        const action = new vscode.CodeAction(
          "Fix both",
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(file, range, "after");
        action.edit.replace(other, range, "after");
        action.command = {
          title: "Do not execute",
          command: "workspaceMcp.testNeverExecute",
        };
        return [action];
      },
    }),
  ];
  const input = () => ({
    uri: file.toString(),
    version: document.version,
    position: { line: 0, character: 0 },
    newName: "after",
  });
  const beforeWrites = provider.writes;
  try {
    const rename = await service.rename(input());
    assert.equal(rename.providerResult, true);
    assert.equal(rename.preview.applicable, false);
    assert.equal(rename.preview.supported, false);
    assert.equal(rename.preview.complete, false);
    assert.deepEqual(rename.preview.reasons, ["OPAQUE_WORKSPACE_EDIT"]);
    assert.equal(rename.preview.documents.length, 2);
    assert.equal(rename.preview.documents[1]?.version, sibling.version);
    const actions = await service.codeActions({
      uri: file.toString(),
      version: document.version,
      range,
      kind: "quickfix",
    });
    assert.equal(actions.actions.length, 1);
    assert.equal(actions.actions[0]?.documents.length, 2);
    assert.ok(actions.actions[0]?.reasons.includes("COMMAND_REQUIRED"));
    assert.equal(commandRuns, 0);
    assert.equal(document.getText(), "before");
    assert.equal(sibling.getText(), "before");
    for (const [unsafe, code] of [
      [outside, "OUTSIDE_WORKSPACE"],
      [linked, "SYMLINK_DENIED"],
    ] as const) {
      target = unsafe;
      await assert.rejects(
        service.rename(input()),
        (error: unknown) =>
          error instanceof WorkspaceError && error.code === code,
      );
    }
    target = other;
    mutate = true;
    await assert.rejects(
      service.rename(input()),
      (error: unknown) =>
        error instanceof WorkspaceError && error.code === "VERSION_CONFLICT",
    );
    assert.equal(provider.writes, beforeWrites);
  } finally {
    registrations.forEach((registration) => registration.dispose());
    service.dispose();
  }
}
