import assert from "node:assert/strict";
import test from "node:test";
import { CommandService, type CommandHost } from "../src/commands.js";

function fixture() {
  const calls: string[] = [];
  const manifest = {
    version: "1.0.0",
    contributes: {
      commands: [
        { command: "one.run", title: "Run", category: "One" },
        { command: "one.prompt", title: "Prompt" },
      ],
    },
    workspaceMcpCommandContracts: [
      {
        command: "one.run",
        extensionVersion: "1.0.0",
        arguments: "none",
        interaction: "none",
        context: "workspace",
        documentation: "https://example.org/contract",
        requiresConfiguration: [{ key: "one.ready", value: true }],
      },
    ],
  };
  const state = {
    trusted: true,
    authorized: true,
    allowedCommands: ["one.run", "one.prompt", "unknown"] as unknown,
    context: "workspace/editor:1",
  };
  let ready: unknown = true;
  const host: CommandHost = {
    getCommands: async () => ["one.run", "one.prompt", "unknown", "_internal"],
    extensions: () => [{ id: "example.one", packageJSON: manifest }],
    state: () => state,
    configuration: () => ready,
    executeCommand: (id) => {
      calls.push(id);
      return undefined;
    },
  };
  return {
    host,
    state,
    manifest,
    calls,
    ready: (value: unknown) => {
      ready = value;
    },
    service: new CommandService(host),
  };
}

const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;

test("discovery enriches metadata, paginates and never probes handlers", async () => {
  const f = fixture();
  const page = await f.service.search({ query: "one", maxResults: 1 });
  assert.equal(page.commands.length, 1);
  assert.equal(page.commands[0]?.commandId, "one.prompt");
  assert.equal(page.commands[0]?.metadata[0]?.extensionId, "example.one");
  assert.equal(page.commands[0]?.eligibility.reason, "UNSUPPORTED_CONTRACT");
  assert.equal(page.nextOffset, 1);
  const next = await f.service.search({
    query: "one",
    offset: page.nextOffset,
  });
  assert.equal(next.commands[0]?.eligibility.eligible, true);
  assert.deepEqual(f.calls, []);
});

test("authorization is separate from capability evidence; unknown and prompting denied predispatch", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.invoke({ commandId: "one.prompt" }),
    code("COMMAND_UNSUPPORTED"),
  );
  await assert.rejects(
    f.service.invoke({ commandId: "unknown" }),
    code("COMMAND_UNSUPPORTED"),
  );
  f.state.allowedCommands = [];
  await assert.rejects(
    f.service.invoke({ commandId: "one.run" }),
    code("COMMAND_NOT_AUTHORIZED"),
  );
  f.state.allowedCommands = "one.run";
  await assert.rejects(
    f.service.invoke({ commandId: "one.run" }),
    code("COMMAND_NOT_AUTHORIZED"),
  );
  assert.deepEqual(f.calls, []);
});

test("valid command executes exactly once with zero arguments and undefined is handler completion", async () => {
  const f = fixture();
  let args: unknown[] = [];
  f.host.executeCommand = (...values) => {
    args = values;
    return undefined;
  };
  const result = await f.service.invoke({ commandId: "one.run" });
  assert.deepEqual(args, ["one.run"]);
  assert.equal(result.outcome, "handler_completed");
  assert.equal(result.resultType, "undefined");
  assert.equal(result.businessSuccess, "unknown");
});

for (const change of [
  "version",
  "prerequisite",
  "context",
  "authorization",
  "trust",
  "stop",
  "cancel",
] as const) {
  test(`invalidates ${change} during asynchronous command discovery before dispatch`, async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.getCommands = async () => {
      if (change === "version") f.manifest.version = "2.0.0";
      if (change === "prerequisite") f.ready(false);
      if (change === "context") f.state.context = "workspace/editor:2";
      if (change === "authorization") f.state.allowedCommands = [];
      if (change === "trust") f.state.trusted = false;
      if (change === "stop") f.service.dispose();
      if (change === "cancel") controller.abort();
      return ["one.run"];
    };
    await assert.rejects(
      f.service.invoke({ commandId: "one.run" }, controller.signal),
    );
    assert.deepEqual(f.calls, []);
  });
}

test("stale versions, unmet prerequisites and ambiguous metadata cannot grant eligibility", async () => {
  const f = fixture();
  f.manifest.version = "2.0.0";
  assert.equal(
    (await f.service.search({ query: "one.run" })).commands[0]?.eligibility
      .reason,
    "STALE_CONTRACT",
  );
  f.manifest.version = "1.0.0";
  f.ready(false);
  assert.equal(
    (await f.service.search({ query: "one.run" })).commands[0]?.eligibility
      .reason,
    "PREREQUISITE_UNMET",
  );
  f.ready(true);
  f.host.extensions = () => [
    { id: "example.one", packageJSON: f.manifest },
    { id: "example.two", packageJSON: f.manifest },
  ];
  await assert.rejects(
    f.service.invoke({ commandId: "one.run" }),
    code("COMMAND_UNSUPPORTED"),
  );
  assert.deepEqual(f.calls, []);
});

test("synchronous throws and rejected/hostile errors produce fixed handler failure", async () => {
  const f = fixture();
  for (const dispatch of [
    () => {
      throw {
        get message() {
          throw new Error("secret");
        },
      };
    },
    () => Promise.reject("password=secret"),
  ]) {
    f.host.executeCommand = dispatch;
    const result = await f.service.invoke({ commandId: "one.run" });
    assert.equal(result.outcome, "handler_failed");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("opaque, cyclic, nonJSON and secret-bearing results are omitted without reading properties", async () => {
  const f = fixture();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const hostile = {
    get token() {
      throw new Error("getter executed");
    },
    toJSON() {
      throw new Error("toJSON executed");
    },
  };
  for (const result of [
    "password=secret",
    cyclic,
    hostile,
    ["secret"],
    1n,
    Symbol("secret"),
    () => "secret",
    NaN,
    Infinity,
  ]) {
    f.host.executeCommand = () => result;
    const returned = await f.service.invoke({ commandId: "one.run" });
    assert.equal(returned.outcome, "handler_completed");
    assert.equal(returned.resultOmitted, true);
    assert.equal("value" in returned, false);
    assert.equal(JSON.stringify(returned).includes("secret"), false);
  }
});

test("timeout retains four outstanding handlers across service restarts until late settlement", async () => {
  const f = fixture();
  const releases: Array<() => void> = [];
  f.host.executeCommand = () =>
    new Promise((_resolve, reject) => {
      releases.push(() => reject(new Error("late secret")));
    });
  try {
    const replies = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.service.invoke({ commandId: "one.run", timeoutMs: 5 }),
      ),
    );
    assert.ok(
      replies.every(
        (reply) =>
          reply.outcome === "completion_unconfirmed" &&
          reply.reason === "timeout",
      ),
    );
    f.service.dispose();
    const restarted = new CommandService(f.host);
    await assert.rejects(
      restarted.invoke({ commandId: "one.run", timeoutMs: 5 }),
      code("COMMAND_BUSY"),
    );
    assert.equal(releases.length, 4);
  } finally {
    for (const release of releases) release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  f.host.executeCommand = () => true;
  assert.equal(
    (await new CommandService(f.host).invoke({ commandId: "one.run" })).outcome,
    "handler_completed",
  );
});

test("cancellation after dispatch returns unconfirmed and cannot retry or cancel handler", async () => {
  const f = fixture();
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  f.host.executeCommand = () => {
    calls++;
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const pending = f.service.invoke({ commandId: "one.run" }, controller.signal);
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.outcome, "completion_unconfirmed");
  assert.equal(result.reason, "cancelled");
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
});

test("revoked proxy result is opaque and settled handlers release capacity", async () => {
  const f = fixture();
  f.host.executeCommand = () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    const promise = Promise.resolve(proxy);
    queueMicrotask(revoke);
    return promise;
  };
  for (let call = 0; call < 5; call++) {
    const result = await f.service.invoke({ commandId: "one.run" });
    assert.equal(result.outcome, "handler_completed");
    assert.equal(result.resultType, "object");
    assert.equal(result.resultOmitted, true);
  }
});

test("discovery is bounded and incomplete metadata cannot authorize dispatch", async () => {
  const f = fixture();
  f.host.getCommands = async () =>
    Array.from({ length: 10_001 }, (_, index) =>
      index === 0 ? "one.run" : `other.${index}`,
    );
  const oversized = await f.service.search({ maxResults: 100 });
  assert.equal(oversized.commands.length, 100);
  assert.equal(oversized.scanned, 10_000);
  assert.equal(oversized.incomplete, true);
  assert.equal(oversized.truncated, true);
  assert.ok(oversized.commands.every((entry) => !entry.eligibility.eligible));
  await assert.rejects(
    f.service.invoke({ commandId: "one.run" }),
    code("COMMAND_UNSUPPORTED"),
  );
  f.host.getCommands = async () => ["one.run"];
  f.host.extensions = () =>
    Array.from({ length: 257 }, (_, index) => ({
      id: `example.${index}`,
      packageJSON: f.manifest,
    }));
  assert.equal(
    (await f.service.search({})).commands[0]?.eligibility.reason,
    "DISCOVERY_INCOMPLETE",
  );
  await assert.rejects(
    f.service.invoke({ commandId: "one.run" }),
    code("COMMAND_UNSUPPORTED"),
  );
  assert.deepEqual(f.calls, []);
});

test("malformed declarations and missing workspace prerequisites fail closed", async () => {
  const f = fixture();
  f.state.context = "";
  await assert.rejects(
    f.service.invoke({ commandId: "one.run" }),
    code("COMMAND_UNSUPPORTED"),
  );
  f.state.context = "workspace";
  (f.manifest.workspaceMcpCommandContracts[0] as any).interaction = "prompt";
  await assert.rejects(
    f.service.invoke({ commandId: "one.run" }),
    code("COMMAND_UNSUPPORTED"),
  );
  assert.deepEqual(f.calls, []);
});

test("numeric and boolean scalar payloads are summarized without exposing credential values", async () => {
  const f = fixture();
  for (const value of [123456, false, null]) {
    f.host.executeCommand = () => value;
    const result = await f.service.invoke({ commandId: "one.run" });
    assert.equal(result.outcome, "handler_completed");
    assert.equal("value" in result, false);
    assert.equal(result.resultOmitted, true);
  }
});
