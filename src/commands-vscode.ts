import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { CommandService } from "./commands.js";

/** Public VS Code APIs only. No explicit activation/probing or UI interception. Invocation may let
 * VS Code normally activate the selected extension. */
export function createCommandService(
  authorized: () => boolean,
): CommandService {
  let generation = 0;
  const prerequisiteKeys = new Set<string>();
  const changed = () => {
    generation++;
  };
  const subscriptions = [
    vscode.extensions.onDidChange(changed),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("workspaceMcp.allowedCommands") ||
        [...prerequisiteKeys].some((key) => event.affectsConfiguration(key))
      )
        changed();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(changed),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document)
        changed();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document === vscode.window.activeTextEditor?.document) changed();
    }),
    vscode.window.onDidChangeActiveTextEditor(changed),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) changed();
    }),
  ];
  const service = new CommandService({
    getCommands: () => vscode.commands.getCommands(true),
    extensions: () => {
      prerequisiteKeys.clear();
      return vscode.extensions.all;
    },
    state: () => {
      const roots = vscode.workspace.workspaceFolders ?? [];
      const editor = vscode.window.activeTextEditor;
      const context = roots.length
        ? createHash("sha256")
            .update(
              JSON.stringify({
                generation,
                roots: roots.map((root) => root.uri.toString()),
                editor: editor
                  ? {
                      uri: editor.document.uri.toString(),
                      version: editor.document.version,
                      selections: editor.selections.map((selection) => [
                        selection.anchor.line,
                        selection.anchor.character,
                        selection.active.line,
                        selection.active.character,
                      ]),
                    }
                  : null,
              }),
            )
            .digest("hex")
        : "";
      return {
        trusted: vscode.workspace.isTrusted,
        authorized: authorized(),
        // Application/user settings alone supply authority, never workspace or
        // folder overrides and never existing buffer-write permission.
        allowedCommands: vscode.workspace
          .getConfiguration("workspaceMcp")
          .inspect("allowedCommands")?.globalValue,
        context,
      };
    },
    configuration: (key) => {
      prerequisiteKeys.add(key);
      return vscode.workspace.getConfiguration().get(key);
    },
    executeCommand: (commandId) => vscode.commands.executeCommand(commandId),
  });
  const dispose = service.dispose.bind(service);
  service.dispose = () => {
    dispose();
    for (const subscription of subscriptions) subscription.dispose();
  };
  return service;
}
