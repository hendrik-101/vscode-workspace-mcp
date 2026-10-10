import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import test from "node:test";
import { CommandService } from "../src/commands.js";

test("VS Code adapter filters internal IDs and reads command authority only from globalValue", async () => {
  const events: Array<(event: any) => void> = [];
  let disposed = 0;
  let globalValue: unknown;
  let filter: unknown;
  const event = (listener: (event: any) => void) => {
    events.push(listener);
    return {
      dispose() {
        disposed++;
      },
    };
  };
  const manifest = {
    version: "1",
    contributes: { commands: [{ command: "fixture.run", title: "Run" }] },
    workspaceMcpCommandContracts: [
      {
        command: "fixture.run",
        extensionVersion: "1",
        arguments: "none",
        interaction: "none",
        context: "workspace",
        documentation: "https://example.org",
        requiresConfiguration: [{ key: "fixture.ready", value: true }],
      },
    ],
  };
  const vscode = {
    extensions: {
      all: [{ id: "fixture.one", packageJSON: manifest }],
      onDidChange: event,
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { toString: () => "memfs:/project" } }],
      getConfiguration: () => ({
        inspect: () => ({
          globalValue,
          workspaceValue: ["fixture.run"],
          workspaceFolderValue: ["fixture.run"],
        }),
        get: (key: string) => (key === "fixture.ready" ? true : undefined),
      }),
      onDidChangeConfiguration: event,
      onDidChangeWorkspaceFolders: event,
      onDidChangeTextDocument: event,
      onDidCloseTextDocument: event,
    },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: event,
      onDidChangeTextEditorSelection: event,
    },
    commands: {
      getCommands: async (value: unknown) => {
        filter = value;
        return ["fixture.run"];
      },
      executeCommand: () => undefined,
    },
  };
  const module = {
    exports: {} as {
      createCommandService: (authorized: () => boolean) => CommandService;
    },
  };
  runInNewContext(
    transformSync(readFileSync("src/commands-vscode.ts", "utf8"), {
      loader: "ts",
      format: "cjs",
    }).code,
    {
      module,
      exports: module.exports,
      require: (id: string) => {
        if (id === "vscode") return vscode;
        if (id === "./commands.js") return { CommandService };
        if (id === "node:crypto") return { createHash };
        throw new Error(`Unexpected import ${id}`);
      },
    },
  );
  const service = module.exports.createCommandService(() => true);
  assert.equal(
    (await service.search({})).commands[0]?.eligibility.reason,
    "NOT_AUTHORIZED",
  );
  assert.equal(filter, true);
  globalValue = ["fixture.run"];
  assert.equal(
    (await service.search({})).commands[0]?.eligibility.eligible,
    true,
  );
  // Changes to unrelated settings/documents/selections cannot starve commands.
  vscode.commands.getCommands = async () => {
    for (const index of [1, 3, 4, 6])
      events[index]!({
        affectsConfiguration: () => false,
        document: {},
        textEditor: {},
      });
    return ["fixture.run"];
  };
  assert.equal(
    (await service.invoke({ commandId: "fixture.run" })).outcome,
    "handler_completed",
  );
  // Relevant context changed and reverted while awaiting IDs must invalidate.
  vscode.commands.getCommands = async () => {
    events[1]!({
      affectsConfiguration: (key: string) => key === "fixture.ready",
    });
    return ["fixture.run"];
  };
  await assert.rejects(
    service.invoke({ commandId: "fixture.run" }),
    (error: unknown) =>
      (error as { code: string }).code === "COMMAND_CONTEXT_CHANGED",
  );
  service.dispose();
  assert.equal(disposed, events.length);
});
