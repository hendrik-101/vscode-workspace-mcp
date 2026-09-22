import * as vscode from "vscode";
import {
  TLS_KEY,
  parseIdentity,
  rotateIdentity,
  storedIdentity,
  type ServerIdentity,
} from "./tls";
import {
  DEFAULT_PORT,
  portPreference,
  writePreference,
  WRITE_CHOICES,
  writeDecision,
  storedToken,
  rotateToken,
  TOKEN_KEY,
} from "./preferences";
import { clientConfiguration } from "./configuration";
import { installAdapter } from "./adapter";
import { startServer } from "./server";
import { BridgeSession } from "./session";
import { WorkspaceService } from "./workspace";

let running: BridgeSession | undefined;
let runningIdentity: ServerIdentity | undefined;
let runningAdapter: string | undefined;
let runningAccess: { allowed: boolean } | undefined;
let starting = Promise.resolve();
let stopping = Promise.resolve();
let binding = Promise.resolve();
let credentialWrites = Promise.resolve();
let adapterWrites = Promise.resolve();
let pending: BridgeSession | undefined;
let cancelStartup: (() => void) | undefined;
const cancelledStartup = Symbol("cancelled startup");
let generation = 0;

/** Revokes known listeners immediately, without waiting for SecretStorage. */
function stopSessions(): Promise<void> {
  generation++;
  cancelStartup?.();
  cancelStartup = undefined;
  const sessions = [running, pending];
  running = undefined;
  pending = undefined;
  runningIdentity = undefined;
  runningAdapter = undefined;
  if (runningAccess) runningAccess.allowed = false;
  runningAccess = undefined;
  stopping = Promise.all([
    stopping.catch(() => {}),
    ...sessions.map((session) => session?.stop()),
  ]).then(() => {});
  return stopping;
}

/** Registers the commands and status item that control this window's bridge session. */
export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
  );
  status.command = "workspaceMcp.connection";
  let windowPort: number | undefined;
  let portPromptGeneration = 0;
  const refresh = () => {
    const suspended = !!running && !runningAccess?.allowed;
    status.text = `$(plug) MCP ${running ? new URL(running.connection.url).port : ""}: ${suspended ? "suspended" : running?.canWrite() ? "read/write" : "read only"}`;
    status.tooltip = `${running?.connection.url ?? "Workspace MCP"} — ${
      suspended
        ? "Access is suspended while stored credentials are verified."
        : "This window's bridge. Stop it or disable writes from the command palette."
    }`;
    if (running) status.show();
    else status.hide();
  };
  const settings = () => vscode.workspace.getConfiguration("workspaceMcp");
  // Only explicit user settings may grant authority; ignore workspace overrides.
  const policy = () =>
    writePreference(settings().inspect("writePolicy")?.globalValue);
  const port = () =>
    windowPort ?? portPreference(settings().inspect("port")?.globalValue);
  const stop = () => {
    const closing = stopSessions();
    refresh();
    return closing;
  };
  // Once SecretStorage.store begins it cannot be cancelled. Serialize writes and
  // keep their completion separate from cancellable Start/Stop command promises.
  const storeCredential = (key: string, value: string, owner: number) => {
    const writing = credentialWrites.then(() => {
      if (owner !== generation) return;
      return context.secrets.store(key, value);
    });
    credentialWrites = writing.catch(() => {});
    return writing;
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
        ? "Workspace MCP port is already in use. Stop the bridge in the other window or run Workspace MCP: Select Port for This Window."
        : error instanceof Error &&
            /^(Workspace MCP port|Workspace MCP adapter|Stored Workspace MCP token|Stored Workspace MCP server identity)/.test(
              error.message,
            )
          ? error.message
          : "Workspace MCP could not complete the operation. Check workspace trust and restart the bridge.";
    void vscode.window.showErrorMessage(message);
  };
  let secretGeneration = 0;
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (event.key !== TOKEN_KEY && event.key !== TLS_KEY) return;
      const requestedSecret = ++secretGeneration;
      const session = running;
      const access = runningAccess;
      const identity = runningIdentity;
      if (!session || !access || !identity) return;
      // Suspend requests and writes synchronously while checking a secret event.
      // A delayed event for our own initial store must not stop a healthy bridge.
      access.allowed = false;
      session.connection.abortRequests();
      refresh();
      void Promise.all([
        context.secrets.get(TOKEN_KEY),
        context.secrets.get(TLS_KEY),
      ])
        .then(([token, rawIdentity]) => {
          if (running !== session || requestedSecret !== secretGeneration)
            return;
          if (token !== undefined && !/^[a-f0-9]{64}$/.test(token)) {
            void stop().catch(report);
            void vscode.window.showWarningMessage(
              "Workspace MCP stopped because its stored token is invalid. Use Rotate Token, then update client configuration.",
            );
            return;
          }
          let current: ServerIdentity;
          try {
            current = parseIdentity(rawIdentity ?? "");
          } catch {
            void stop().catch(report);
            void vscode.window.showWarningMessage(
              "Workspace MCP stopped because its stored server identity is invalid or expired. Use Rotate Server Identity, then update client configuration.",
            );
            return;
          }
          if (
            token === session.connection.token &&
            current.cert === identity.cert &&
            current.key === identity.key
          ) {
            access.allowed = true;
            refresh();
          } else {
            void stop().catch(report);
            void vscode.window.showWarningMessage(
              "Workspace MCP stopped because its stored credentials changed. Restart and refresh client configuration.",
            );
          }
        })
        .catch(() => {
          if (running === session && requestedSecret === secretGeneration) {
            void stop().catch(report);
            void vscode.window.showWarningMessage(
              "Workspace MCP stopped because secure token storage could not be read. Check VS Code secret storage and restart the bridge.",
            );
          }
        });
    }),
  );
  const register = (id: string, action: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => action().catch(report)),
    );
  register("workspaceMcp.start", () => {
    if (running) return Promise.resolve();
    if (cancelStartup) void stopSessions().catch(report);
    const requestedGeneration = ++generation;
    const requestedWrites = ++promptGeneration;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(cancelledStartup);
    });
    cancelStartup = cancel;
    const wait = <T>(operation: PromiseLike<T>): Promise<T> =>
      Promise.race([operation, cancelled]);
    const checkCurrent = () => {
      if (requestedGeneration !== generation) throw cancelledStartup;
    };
    // Cancel each storage await, so a stale initialization cannot later store secrets.
    const secrets = {
      get: (key: string) => {
        checkCurrent();
        return wait(context.secrets.get(key));
      },
      store: (key: string, value: string) => {
        checkCurrent();
        return wait(storeCredential(key, value, requestedGeneration));
      },
    };
    starting = wait(
      starting
        .catch(() => {})
        .then(async () => {
          checkCurrent();
          await wait(stopping);
          await wait(binding);
          await wait(credentialWrites);
          await wait(adapterWrites);
          checkCurrent();
          if (running) return;
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
          const installing = installAdapter(context, checkCurrent).catch(
            (error: unknown) => {
              if (error === cancelledStartup) throw error;
              if (
                error instanceof Error &&
                error.message.startsWith("Workspace MCP adapter")
              )
                throw error;
              throw new Error(
                "Workspace MCP adapter could not be installed. Check extension storage on this host and restart the bridge.",
              );
            },
          );
          // Stop stays responsive, but another Start must wait for already-issued
          // filesystem operations. Installer guards prevent later stale publication.
          adapterWrites = installing.then(
            () => {},
            () => {},
          );
          const adapter = await wait(installing);
          checkCurrent();
          const token = await storedToken(secrets);
          const identity = await storedIdentity(secrets);
          if (requestedGeneration !== generation) return;
          const opening = startServer(workspace, {
            port: configuredPort,
            token,
            tls: identity,
            authorized: () => access.allowed,
          }).then(async (connection) => {
            const created = new BridgeSession(connection);
            if (requestedGeneration !== generation) {
              await created.stop();
              throw cancelledStartup;
            }
            pending = created;
            return created;
          });
          // Stop need not await an unknown bind, but another Start must not race it.
          binding = opening.then(
            () => {},
            () => {},
          );
          const started = await wait(opening);
          session = started;
          // Another window may have initialized or rotated this endpoint's secret.
          try {
            let stable = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              const requestedSecret = secretGeneration;
              const [current, rawIdentity] = await Promise.all([
                secrets.get(TOKEN_KEY),
                secrets.get(TLS_KEY),
              ]);
              if (requestedSecret !== secretGeneration) continue;
              if (current !== undefined && !/^[a-f0-9]{64}$/.test(current))
                throw new Error(
                  "Stored Workspace MCP token is invalid. Use Rotate Token, then update client configuration.",
                );
              const currentIdentity = parseIdentity(rawIdentity ?? "");
              if (
                currentIdentity.cert !== identity.cert ||
                currentIdentity.key !== identity.key
              )
                throw new Error(
                  "Stored Workspace MCP server identity changed during startup. Restart the bridge and refresh client configuration, including its trusted certificate.",
                );
              if (current !== token)
                throw new Error(
                  "Stored Workspace MCP token changed during startup. Restart the bridge and refresh client configuration.",
                );
              stable = true;
              break;
            }
            if (!stable)
              throw new Error(
                "Stored Workspace MCP token or server identity kept changing during startup. Retry when credential changes have finished, then refresh client configuration.",
              );
          } catch (error) {
            if (pending === started) {
              pending = undefined;
              stopping = started.stop();
              await stopping;
            }
            throw error;
          }
          if (requestedGeneration !== generation) return;
          pending = undefined;
          running = started;
          runningAccess = access;
          runningIdentity = identity;
          runningAdapter = adapter;
          access.allowed = true;
          if (requestedWrites === promptGeneration) {
            if (policy() === "allow") started.enableWrites();
            if (policy() === "ask") void askWrites(started).catch(report);
          }
          refresh();
          // An informational toast must never hold the lifecycle or Stop command open.
          void vscode.window
            .showInformationMessage(
              "Workspace MCP started. The status bar shows current write access.",
              "Connection details",
            )
            .then((choice) => {
              if (choice && running === started)
                void vscode.commands.executeCommand("workspaceMcp.connection");
            });
        }),
    )
      .catch((error: unknown) => {
        if (error !== cancelledStartup) throw error;
      })
      .finally(() => {
        if (cancelStartup === cancel) cancelStartup = undefined;
      });
    return starting;
  });
  register("workspaceMcp.stop", async () => {
    await stop();
  });
  register("workspaceMcp.selectPort", async () => {
    const requestedGeneration = generation;
    const requestedPrompt = ++portPromptGeneration;
    const parsePort = (value: string) =>
      portPreference(/^\d+$/.test(value.trim()) ? Number(value) : NaN);
    const value = await vscode.window.showInputBox({
      title: "Workspace MCP: Select Port for This Window",
      prompt:
        "Port 1024–65535. Selecting stops this window's bridge; run Start afterwards. Resets on window reload. No settings are saved.",
      value: String(
        windowPort ?? settings().inspect("port")?.globalValue ?? DEFAULT_PORT,
      ),
      validateInput: (input) => {
        try {
          parsePort(input);
          return undefined;
        } catch {
          return "Enter an integer port from 1024 to 65535.";
        }
      },
    });
    if (
      value === undefined ||
      requestedGeneration !== generation ||
      requestedPrompt !== portPromptGeneration
    )
      return;
    windowPort = parsePort(value);
    await stop();
    void vscode.window.showInformationMessage(
      `Workspace MCP port ${windowPort} selected for this window. Run Start, then refresh this window's private client configuration.`,
    );
  });
  register("workspaceMcp.disableWrites", async () => {
    // A response to an older prompt (or delayed persistence) cannot grant again.
    promptGeneration++;
    running?.disableWrites();
    pending?.disableWrites();
    refresh();
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
    const closing = stop();
    const requestedGeneration = generation;
    await closing;
    if (requestedGeneration !== generation) return;
    const choice = await vscode.window.showWarningMessage(
      "Rotate the Workspace MCP token for this VS Code profile? Existing client configurations must be updated. The bridge remains stopped.",
      { modal: true },
      "Rotate token",
    );
    if (choice !== "Rotate token" || requestedGeneration !== generation) return;
    await rotateToken({
      get: (key) => context.secrets.get(key),
      store: (key, value) => storeCredential(key, value, requestedGeneration),
    });
    if (requestedGeneration !== generation) return;
    void vscode.window.showInformationMessage(
      "Token rotated. Start Workspace MCP and update your private client configuration.",
    );
  });
  register("workspaceMcp.rotateIdentity", async () => {
    const closing = stop();
    const requestedGeneration = generation;
    await closing;
    if (requestedGeneration !== generation) return;
    const choice = await vscode.window.showWarningMessage(
      "Replace the Workspace MCP server identity? Existing client configurations must be updated. The bearer token is unchanged and the bridge remains stopped.",
      { modal: true },
      "Replace server identity",
    );
    if (
      choice !== "Replace server identity" ||
      requestedGeneration !== generation
    )
      return;
    await rotateIdentity({
      get: (key) => context.secrets.get(key),
      store: (key, value) => storeCredential(key, value, requestedGeneration),
    });
    if (requestedGeneration !== generation) return;
    void vscode.window.showInformationMessage(
      "Server identity replaced. Start Workspace MCP and update your private client configuration.",
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
          label: "Claude Code / compatible stdio MCP client",
          value: "claude" as const,
        },
      ],
      {
        title: `Connection configuration — ${session.connection.url}`,
        placeHolder:
          "Contains a private token. Keep it out of repositories and shared logs.",
      },
    );
    if (!client || running !== session) return;
    const identity = runningIdentity;
    const adapter = runningAdapter;
    if (!identity || !adapter) return;
    const { url, token } = session.connection;
    const document = await vscode.workspace.openTextDocument({
      language: client.value === "claude" ? "json" : "toml",
      content: clientConfiguration(
        client.value,
        adapter,
        url,
        token,
        identity.cert,
      ),
    });
    await vscode.window.showTextDocument(document, { preview: false });
    void vscode.window.showInformationMessage(
      "This private token remains valid across restarts until you explicitly rotate it. Copy these settings to your client's user configuration. The client must run on the same host.",
    );
  });
  context.subscriptions.push(status, {
    dispose: () => {
      void deactivate().catch(report);
    },
  });
}

/** Revokes active and starting sessions without waiting for unavailable storage. */
export async function deactivate(): Promise<void> {
  await stopSessions();
}
