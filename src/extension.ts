import * as vscode from "vscode";
import { clientConfiguration } from "./configuration";
import { startServer } from "./server";
import { WorkspaceService } from "./workspace";

type RunningServer = Awaited<ReturnType<typeof startServer>>;
let running: RunningServer | undefined;
let writes = false;
let lifecycle = Promise.resolve();

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
  );
  status.command = "workspaceMcp.connection";
  const refresh = () => {
    status.text = `$(plug) MCP: ${writes ? "read/write" : "read only"}`;
    status.tooltip =
      "Workspace MCP is listening on this host's loopback interface. Stop it from the command palette.";
    if (running) status.show();
    else status.hide();
  };
  const workspace = new WorkspaceService(
    () => writes && vscode.workspace.isTrusted,
  );
  const register = (id: string, action: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        lifecycle = lifecycle.then(action).catch(() => {
          void vscode.window.showErrorMessage(
            "Workspace MCP could not complete the operation. Check workspace trust and restart the bridge.",
          );
        });
        return lifecycle;
      }),
    );
  register("workspaceMcp.start", async () => {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Trust this workspace before starting Workspace MCP.",
      );
      return;
    }
    if (!running) {
      writes = false;
      running = await startServer(workspace);
    }
    refresh();
    const choice = await vscode.window.showInformationMessage(
      "Workspace MCP started with read-only access.",
      "Connection details",
    );
    if (choice) void vscode.commands.executeCommand("workspaceMcp.connection");
  });
  register("workspaceMcp.stop", async () => {
    writes = false;
    const server = running;
    running = undefined;
    refresh();
    await server?.close();
  });
  register("workspaceMcp.enableWrites", async () => {
    if (!running || !vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Start Workspace MCP in a trusted workspace first.",
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Allow connected MCP clients to edit and save documents in this window's workspace roots until the bridge stops? Saving may trigger your filesystem provider's backend operations.",
      { modal: true },
      "Enable writes",
    );
    if (choice === "Enable writes") writes = true;
    refresh();
  });
  register("workspaceMcp.connection", async () => {
    if (!running) {
      await vscode.window.showInformationMessage(
        "Run Workspace MCP: Start first.",
      );
      return;
    }
    const client = await vscode.window.showQuickPick(
      [
        {
          label: "Codex / ChatGPT desktop (local Codex host)",
          value: "codex" as const,
        },
        {
          label: "Claude Code / compatible HTTP MCP client",
          value: "claude" as const,
        },
      ],
      {
        title: "Connection configuration",
        placeHolder:
          "Contains a private token. Keep it out of repositories and shared logs.",
      },
    );
    if (!client) return;
    const document = await vscode.workspace.openTextDocument({
      language: client.value === "claude" ? "json" : "toml",
      content: clientConfiguration(client.value, running.url, running.token),
    });
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.window.showInformationMessage(
      "This private token expires when the bridge stops. Copy these settings to your client's user configuration. The client must run on the same host.",
    );
  });
  context.subscriptions.push(status, {
    dispose: () => {
      writes = false;
      void running?.close();
      running = undefined;
    },
  });
}

export async function deactivate(): Promise<void> {
  await lifecycle;
  writes = false;
  const server = running;
  running = undefined;
  await server?.close();
}
