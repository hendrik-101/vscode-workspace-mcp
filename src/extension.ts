import * as vscode from "vscode";
import {
  portPreference,
  writePreference,
  WRITE_CHOICES,
  writeDecision,
  storedToken,
  rotateToken,
  TOKEN_KEY,
} from "./preferences";
import { clientConfiguration } from "./configuration";
import { startServer } from "./server";
import { BridgeSession } from "./session";
import { WorkspaceService } from "./workspace";

let running: BridgeSession | undefined;
let runningAccess: { allowed: boolean } | undefined;
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
  const settings = () => vscode.workspace.getConfiguration("workspaceMcp");
  // Only explicit user settings may grant authority; ignore workspace overrides.
  const policy = () =>
    writePreference(settings().inspect("writePolicy")?.globalValue);
  const port = () => portPreference(settings().inspect("port")?.globalValue);
  const stop = async () => {
    generation++;
    const session = running;
    running = undefined;
    if (runningAccess) runningAccess.allowed = false;
    runningAccess = undefined;
    const closing = session?.stop();
    refresh();
    await closing;
  };
  let promptGeneration = 0;
  const askWrites = async (session: BridgeSession) => {
    const requestedPrompt = ++promptGeneration;
    const choice = await vscode.window.showWarningMessage(
      "Allow MCP clients to edit and save workspace documents? Saving may invoke backend operations. Agent edits require Auto Save off.",
      { modal: true },
      ...WRITE_CHOICES,
    );
    if (
      running !== session ||
      requestedPrompt !== promptGeneration ||
      !vscode.workspace.isTrusted
    )
      return;
    const decision = writeDecision(choice);
    // Revocation must not depend on a settings write succeeding or finishing.
    if (!decision.allow) {
      session.disableWrites();
      refresh();
    }
    if (decision.persist) {
      await settings().update(
        "writePolicy",
        decision.persist,
        vscode.ConfigurationTarget.Global,
      );
    }
    if (running === session && requestedPrompt === promptGeneration) {
      if (vscode.workspace.isTrusted && decision.allow && policy() !== "deny")
        session.enableWrites();
      else session.disableWrites();
    }
    refresh();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("workspaceMcp.writePolicy")) return;
      if (policy() === "deny") running?.disableWrites();
      refresh();
    }),
  );
  const report = (error: unknown) => {
    const message =
      error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? "Workspace MCP port is already in use. Stop the bridge in the other window or choose another user setting for workspaceMcp.port."
        : error instanceof Error &&
            /^(Workspace MCP port|Stored Workspace MCP token)/.test(
              error.message,
            )
          ? error.message
          : "Workspace MCP could not complete the operation. Check workspace trust and restart the bridge.";
    void vscode.window.showErrorMessage(message);
  };
  let secretGeneration = 0;
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (event.key !== TOKEN_KEY) return;
      const requestedSecret = ++secretGeneration;
      const session = running;
      const access = runningAccess;
      if (!session || !access) return;
      // Suspend requests and writes synchronously while checking a secret event.
      // A delayed event for our own initial store must not stop a healthy bridge.
      access.allowed = false;
      void context.secrets.get(TOKEN_KEY).then(
        (token) => {
          if (running !== session || requestedSecret !== secretGeneration)
            return;
          if (token === session.connection.token) access.allowed = true;
          else {
            void stop().catch(report);
            void vscode.window.showWarningMessage(
              "Workspace MCP stopped because its stored token changed. Restart and refresh client configuration.",
            );
          }
        },
        () => {
          if (running === session && requestedSecret === secretGeneration) {
            void stop().catch(report);
            void vscode.window.showWarningMessage(
              "Workspace MCP stopped because secure token storage could not be read. Check VS Code secret storage and restart the bridge.",
            );
          }
        },
      );
    }),
  );
  const register = (id: string, action: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => action().catch(report)),
    );
  register("workspaceMcp.start", () => {
    if (running) return Promise.resolve();
    const requestedGeneration = ++generation;
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
        const access = { allowed: false };
        const workspace = new WorkspaceService(
          () =>
            access.allowed &&
            !!session?.canWrite() &&
            vscode.workspace.isTrusted &&
            policy() !== "deny",
        );
        const configuredPort = port();
        const token = await storedToken(context.secrets);
        if (requestedGeneration !== generation) return;
        session = new BridgeSession(
          await startServer(workspace, {
            port: configuredPort,
            token,
            authorized: () => access.allowed,
          }),
        );
        // Another window may have initialized or rotated this endpoint's secret.
        try {
          let stable = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const requestedSecret = secretGeneration;
            const current = await context.secrets.get(TOKEN_KEY);
            if (requestedSecret !== secretGeneration) continue;
            stable = current === token;
            break;
          }
          if (!stable)
            throw new Error(
              "Stored Workspace MCP token changed during startup. Restart the bridge.",
            );
        } catch (error) {
          await session.stop();
          throw error;
        }
        if (requestedGeneration !== generation) {
          await session.stop();
          return;
        }
        running = session;
        runningAccess = access;
        access.allowed = true;
        if (policy() === "allow") session.enableWrites();
        if (policy() === "ask") void askWrites(session).catch(report);
        refresh();
        // An informational toast must never hold the lifecycle or Stop command open.
        void vscode.window
          .showInformationMessage(
            "Workspace MCP started. The status bar shows current write access.",
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
    await stop();
    await starting;
  });
  register("workspaceMcp.enableWrites", async () => {
    const session = running;
    if (!session || !vscode.workspace.isTrusted) return;
    if (policy() === "deny") {
      void vscode.window.showWarningMessage(
        "Writes are forbidden by workspaceMcp.writePolicy. Change the user setting to ask or allow and restart.",
      );
      return;
    }
    await askWrites(session);
  });
  register("workspaceMcp.rotateToken", async () => {
    // Revoke before prompting or accessing storage, even if rotation is cancelled.
    await stop();
    await starting.catch(() => {});
    const requestedGeneration = generation;
    const choice = await vscode.window.showWarningMessage(
      "Rotate the Workspace MCP token for this VS Code profile? Existing client configurations must be updated. The bridge remains stopped.",
      { modal: true },
      "Rotate token",
    );
    if (choice !== "Rotate token" || requestedGeneration !== generation) return;
    await rotateToken(context.secrets);
    void vscode.window.showInformationMessage(
      "Token rotated. Start Workspace MCP and update your private client configuration.",
    );
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
      "This private token remains valid across restarts until you explicitly rotate it. Copy these settings to your client's user configuration. The client must run on the same host.",
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
  if (runningAccess) runningAccess.allowed = false;
  runningAccess = undefined;
  await session?.stop();
  await starting;
}
