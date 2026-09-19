import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { transformSync } from "esbuild";
import * as preferences from "../src/preferences";
import { TLS_KEY } from "../src/tls";
import { BridgeSession } from "../src/session";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(initialPolicy: string = "ask") {
  const commands = new Map<string, () => Promise<void>>();
  const prompts: { resolve(value?: string): void }[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const identity = { cert: "test certificate", key: "test private key" };
  const values = new Map<string, string>([[TLS_KEY, JSON.stringify(identity)]]);
  const settings = new Map<string, unknown>([["writePolicy", initialPolicy]]);
  const connections: {
    closed: boolean;
    abortedRequests: number;
    token: string;
    url: string;
    close(): Promise<void>;
  }[] = [];
  const services: { canWrite: () => boolean }[] = [];
  let secretChanged: ((event: { key: string }) => void) | undefined;
  const context = {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: async (key: string) => values.get(key),
      store: async (key: string, value: string) => {
        values.set(key, value);
      },
      onDidChange: (callback: typeof secretChanged) => {
        secretChanged = callback;
        return { dispose() {} };
      },
    },
  };
  const vscode = {
    StatusBarAlignment: { Right: 1 },
    ConfigurationTarget: { Global: 1 },
    commands: {
      registerCommand: (id: string, callback: () => Promise<void>) => {
        commands.set(id, callback);
        return { dispose() {} };
      },
    },
    workspace: {
      isTrusted: true,
      onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({
        inspect: (key: string) => ({
          globalValue: settings.get(key),
          workspaceValue: "allow",
        }),
        update: async (key: string, value: unknown) => {
          await settings.set(key, value);
        },
      }),
    },
    window: {
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showWarningMessage: (message: string) => {
        warnings.push(message);
        return new Promise<string | undefined>((resolve) =>
          prompts.push({ resolve }),
        );
      },
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message: string) => {
        errors.push(message);
        return undefined;
      },
    },
  };
  const exports: {
    activate?: (context: unknown) => void;
    deactivate?: () => Promise<void>;
  } = {};
  const code = transformSync(readFileSync("src/extension.ts", "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code;
  const module = { exports };
  runInNewContext(code, {
    module,
    exports,
    URL,
    require: (id: string) => {
      if (id === "vscode") return vscode;
      if (id === "./preferences") return preferences;
      if (id === "./tls")
        return {
          TLS_KEY,
          storedIdentity: async () => identity,
          parseIdentity: (raw: string) => JSON.parse(raw),
          rotateIdentity: async () => {
            values.set(
              TLS_KEY,
              JSON.stringify({ cert: "new certificate", key: "new key" }),
            );
          },
        };
      if (id === "./session") return { BridgeSession };
      if (id === "./configuration") return {};
      if (id === "./workspace")
        return {
          WorkspaceService: class {
            constructor(canWrite: () => boolean) {
              services.push({ canWrite });
            }
          },
        };
      if (id === "./server")
        return {
          startServer: async (
            _service: unknown,
            options: { port: number; token: string },
          ) => {
            const connection = {
              closed: false,
              abortedRequests: 0,
              abortRequests() {
                this.abortedRequests++;
              },
              token: options.token,
              url: `http://127.0.0.1:${options.port}/mcp`,
              async close() {
                this.closed = true;
              },
            };
            connections.push(connection);
            return connection;
          },
        };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  module.exports.activate!(context);
  const command = async (name: string) => {
    await commands.get(`workspaceMcp.${name}`)!();
  };
  return {
    command,
    warnings,
    errors,
    deactivate: () => module.exports.deactivate!(),
    prompts,
    values,
    settings,
    connections,
    services,
    context,
    changed: (key = preferences.TOKEN_KEY) => secretChanged!({ key }),
  };
}

test("startup prompts never block Stop; stale replies cannot persist or grant writes", async () => {
  const f = fixture();
  await f.command("start");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.services[0]!.canWrite(), false);
  await f.command("stop");
  f.prompts[0]!.resolve("Always allow");
  await tick();
  assert.equal(f.settings.get("writePolicy"), "ask");
  assert.equal(f.services[0]!.canWrite(), false);
  await f.command("start");
  assert.equal(f.connections[0]!.token, f.connections[1]!.token);
  await f.command("stop");
});

for (const [choice, allow, policy] of [
  ["Allow for this session", true, "ask"],
  ["Deny for this session", false, "ask"],
  ["Always allow", true, "allow"],
  ["Always deny", false, "deny"],
  [undefined, false, "ask"],
] as const)
  test(`write prompt: ${choice ?? "dismissed"}`, async () => {
    const f = fixture();
    await f.command("start");
    f.prompts[0]!.resolve(choice);
    await tick();
    assert.equal(f.services[0]!.canWrite(), allow);
    assert.equal(f.settings.get("writePolicy"), policy);
    await f.command("stop");
  });

test("persistent deny cannot be bypassed and secret changes revoke immediately", async () => {
  const f = fixture("deny");
  await f.command("start");
  assert.equal(f.prompts.length, 0);
  await f.command("enableWrites");
  assert.equal(f.services[0]!.canWrite(), false);
  f.values.set(preferences.TOKEN_KEY, "b".repeat(64));
  f.changed();
  assert.equal(f.connections[0]!.abortedRequests, 1);
  assert.equal(f.services[0]!.canWrite(), false);
  await tick();
  assert.equal(f.connections[0]!.closed, true);
  await f.command("stop");
});

test("rotation stops immediately, changes token only after confirmation and stays stopped", async () => {
  const f = fixture("allow");
  await f.command("start");
  const token = f.connections[0]!.token;
  const rotating = f.command("rotateToken");
  assert.equal(f.services[0]!.canWrite(), false);
  await tick();
  assert.equal(f.values.get(preferences.TOKEN_KEY), token);
  f.prompts[0]!.resolve("Rotate token");
  await rotating;
  assert.notEqual(f.values.get(preferences.TOKEN_KEY), token);
  assert.equal(f.connections.length, 1);
});

test("pending persistent permission update cannot regrant after Stop", async () => {
  const f = fixture();
  await f.command("start");
  // Intercept persistence to reproduce a slow settings write.
  const originalSet = f.settings.set.bind(f.settings);
  let release!: () => void;
  f.settings.set = (key: string, value: unknown) => {
    originalSet(key, value);
    return new Promise<void>((resolve) => {
      release = resolve;
    }) as unknown as Map<string, unknown>;
  };
  f.prompts[0]!.resolve("Always allow");
  await tick();
  await f.command("stop");
  release();
  await tick();
  assert.equal(f.services[0]!.canWrite(), false);
});

test("storage failure after bind closes the connection and a later start recovers", async () => {
  const f = fixture("allow");
  f.values.set(preferences.TOKEN_KEY, "a".repeat(64));
  let reads = 0;
  const originalGet = f.context.secrets.get;
  f.context.secrets.get = async (key: string) => {
    if (++reads === 2) throw new Error("Secret storage unavailable");
    return originalGet(key);
  };
  await f.command("start");
  assert.equal(f.connections[0]!.closed, true);
  await f.command("stop");
  await f.command("start");
  assert.equal(f.services[1]!.canWrite(), true);
  await f.command("stop");
});

test("a new start invalidates an outstanding rotation confirmation", async () => {
  const f = fixture("allow");
  await f.command("start");
  const token = f.connections[0]!.token;
  const rotating = f.command("rotateToken");
  await tick();
  await f.command("start");
  f.prompts[0]!.resolve("Rotate token");
  await rotating;
  assert.equal(f.values.get(preferences.TOKEN_KEY), token);
  assert.equal(f.connections[1]!.closed, false);
  await f.command("stop");
});

test("delayed own secret event suspends access then resumes without stopping", async () => {
  const f = fixture("allow");
  await f.command("start");
  f.changed();
  assert.equal(f.connections[0]!.abortedRequests, 1);
  assert.equal(f.services[0]!.canWrite(), false);
  await tick();
  assert.equal(f.connections[0]!.closed, false);
  assert.equal(f.services[0]!.canWrite(), true);
  await f.command("stop");
});

test("older secret read cannot resume access after a newer token change", async () => {
  const f = fixture("allow");
  await f.command("start");
  const token = f.connections[0]!.token;
  const reads: ((token: string) => void)[] = [];
  f.context.secrets.get = async () =>
    new Promise((resolve) => reads.push(resolve));
  f.changed();
  f.changed();
  reads[0]!(token);
  reads[1]!(f.values.get(TLS_KEY)!);
  await tick();
  assert.equal(f.services[0]!.canWrite(), false);
  reads[2]!("b".repeat(64));
  reads[3]!(f.values.get(TLS_KEY)!);
  await tick();
  assert.equal(f.connections[0]!.closed, true);
  await f.command("stop");
});

test("secret change during final startup verification never admits stale credentials", async () => {
  const f = fixture("allow");
  const token = "a".repeat(64);
  f.values.set(preferences.TOKEN_KEY, token);
  const originalGet = f.context.secrets.get;
  let reads = 0;
  f.context.secrets.get = async (key: string) => {
    if (++reads === 2) {
      f.values.set(key, "b".repeat(64));
      f.changed();
      return token; // Simulate a stale response already in flight when the event fired.
    }
    return originalGet(key);
  };
  await f.command("start");
  assert.equal(f.connections[0]!.closed, true);
  assert.equal(f.services[0]!.canWrite(), false);
  await f.command("stop");
});

for (const fails of [false, true])
  test(`Always deny revokes before ${fails ? "failing" : "delayed"} settings persistence`, async () => {
    const f = fixture("allow");
    await f.command("start");
    assert.equal(f.services[0]!.canWrite(), true);
    let finish!: () => void;
    f.settings.set = () =>
      new Promise<void>((resolve, reject) => {
        finish = () =>
          fails ? reject(new Error("Settings unavailable")) : resolve();
      }) as unknown as Map<string, unknown>;
    const changing = f.command("enableWrites");
    f.prompts[0]!.resolve("Always deny");
    await tick();
    assert.equal(f.services[0]!.canWrite(), false);
    assert.equal(f.settings.get("writePolicy"), "allow");
    finish();
    await changing;
    assert.equal(f.services[0]!.canWrite(), false);
    await f.command("stop");
  });

test("secret event read failure stops and reports a safe actionable warning", async () => {
  const f = fixture("allow");
  await f.command("start");
  f.context.secrets.get = async () => {
    throw new Error("Private provider details");
  };
  f.changed();
  assert.equal(f.connections[0]!.abortedRequests, 1);
  assert.equal(f.services[0]!.canWrite(), false);
  await tick();
  assert.equal(f.connections[0]!.closed, true);
  assert.ok(
    f.warnings.some((message) =>
      /secure token storage could not be read/.test(message),
    ),
  );
  assert.ok(
    f.warnings.every(
      (message) => !message.includes("Private provider details"),
    ),
  );
  await f.command("stop");
});

test("failed startup is reported once; Stop and deactivation settle cleanly", async () => {
  const f = fixture();
  f.context.secrets.get = async () => {
    throw new Error("Storage unavailable");
  };
  await f.command("start");
  assert.equal(f.errors.length, 1);
  await f.command("stop");
  assert.equal(f.errors.length, 1);
  await assert.doesNotReject(f.deactivate());
  for (const disposable of f.context.subscriptions) disposable.dispose();
  await tick();
  assert.equal(f.errors.length, 1);
});

test("a changed stored server identity suspends and stops the current session", async () => {
  const f = fixture("allow");
  await f.command("start");
  f.values.set(
    TLS_KEY,
    JSON.stringify({ cert: "different certificate", key: "different key" }),
  );
  f.changed(TLS_KEY);
  assert.equal(f.services[0]!.canWrite(), false);
  await tick();
  assert.equal(f.connections[0]!.closed, true);
  await f.command("stop");
});

test("explicit identity rotation leaves the bearer token intact and bridge stopped", async () => {
  const f = fixture("allow");
  await f.command("start");
  const token = f.values.get(preferences.TOKEN_KEY);
  const originalIdentity = f.values.get(TLS_KEY);
  const rotating = f.command("rotateIdentity");
  assert.equal(f.services[0]!.canWrite(), false);
  await tick();
  f.prompts[0]!.resolve("Replace server identity");
  await rotating;
  assert.equal(f.values.get(preferences.TOKEN_KEY), token);
  assert.notEqual(f.values.get(TLS_KEY), originalIdentity);
  assert.equal(f.connections[0]!.closed, true);
});
