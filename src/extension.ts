import * as vscode from "vscode";
import { clientConfiguration } from "./configuration";
import { startServer } from "./server";
import { BridgeSession } from "./session";
import { WorkspaceService } from "./workspace";

let running: BridgeSession | undefined;
let starting = Promise.resolve();
let generation = 0;

/** Registers the commands and status item that control this window's bridge session. */
export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
  );
  status.command = "workspaceMcp.connection";
  const refresh = () => {
    status.text = `$(plug) MCP: ${running?.canWrite() ? "read/write" : "read only"}`;
    status.tooltip =
      "Workspace MCP is listening on this host's loopback interface. Stop it from the command palette.";
    if (running) status.show();
    else status.hide();
  };
  const register = (id: string, action: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () =>
        action().catch(() => {
          void vscode.window.showErrorMessage(
            "Workspace MCP could not complete the operation. Check workspace trust and restart the bridge.",
          );
        }),
      ),
    );
  register("workspaceMcp.start", () => {
    const requestedGeneration = generation;
    starting = starting
      .catch(() => {})
      .then(async () => {
        if (requestedGeneration !== generation || running) return;
        if (!vscode.workspace.isTrusted) {
          void vscode.window.showWarningMessage(
            "Trust this workspace before starting Workspace MCP.",
          );
          return;
        }
        // Each service captures its own session, never the mutable global session.
        let session: BridgeSession | undefined;
        const workspace = new WorkspaceService(
          () => !!session?.canWrite() && vscode.workspace.isTrusted,
        );
        session = new BridgeSession(await startServer(workspace));
        if (requestedGeneration !== generation) {
          await session.stop();
          return;
        }
        running = session;
        refresh();
        // An informational toast must never hold the lifecycle or Stop command open.
        void vscode.window
          .showInformationMessage(
            "Workspace MCP started with read-only access.",
            "Connection details",
          )
          .then((choice) => {
            if (choice && running === session)
              void vscode.commands.executeCommand("workspaceMcp.connection");
          });
      });
    return starting;
  });
  register("workspaceMcp.stop", async () => {
    generation++;
    const session = running;
    running = undefined;
    const closing = session?.stop(); // Revoke synchronously before any await.
    refresh();
    await closing;
    await starting;
  });
  register("workspaceMcp.enableWrites", async () => {
    const session = running;
    if (!session || !vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        "Start Workspace MCP in a trusted workspace first.",
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Allow connected MCP clients to edit and save documents in this window's workspace roots until the bridge stops? Saving may trigger your filesystem provider's backend operations. Agent edits require Auto Save to be off.",
      { modal: true },
      "Enable writes",
    );
    if (
      choice === "Enable writes" &&
      running === session &&
      vscode.workspace.isTrusted
    )
      session.enableWrites();
    refresh();
  });
  register("workspaceMcp.connection", async () => {
    const session = running;
    if (!session) {
      void vscode.window.showInformationMessage(
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
    if (!client || running !== session) return;
    const { url, token } = session.connection;
    const document = await vscode.workspace.openTextDocument({
      language: client.value === "claude" ? "json" : "toml",
      content: clientConfiguration(client.value, url, token),
    });
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage(
      "This private token expires when the bridge stops. Copy these settings to your client's user configuration. The client must run on the same host.",
    );
  });
  context.subscriptions.push(status, {
    dispose: () => {
      void deactivate();
    },
  });
}

/** Revokes the active session and waits for any in-progress startup to settle. */
export async function deactivate(): Promise<void> {
  generation++;
  const session = running;
  running = undefined;
  await session?.stop();
  await starting;
}
