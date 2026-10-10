import assert from "node:assert/strict";
import * as vscode from "vscode";
import { createCommandService } from "../../src/commands-vscode";

export async function commandTools(): Promise<void> {
  const alpha = vscode.extensions.getExtension<{
    calls: (suffix: string) => number;
  }>("workspace-mcp-fixtures.issue40-alpha");
  const beta = vscode.extensions.getExtension<{
    calls: (suffix: string) => number;
  }>("workspace-mcp-fixtures.issue40-beta");
  assert.ok(
    alpha && beta,
    "Both independent fixture extensions must be loaded",
  );
  assert.equal(alpha.isActive, false);
  assert.equal(beta.isActive, false);
  const settings = vscode.workspace.getConfiguration("workspaceMcp");
  const previous = settings.inspect("allowedCommands")?.globalValue;
  const allowed = [
    "issue40.alpha.complete",
    "issue40.alpha.undefined",
    "issue40.alpha.throw",
    "issue40.alpha.reject",
    "issue40.alpha.hang",
    "issue40.alpha.prompt",
    "issue40.beta.complete",
    "issue40.beta.opaque",
    "issue40.beta.prompt",
  ];
  await settings.update(
    "allowedCommands",
    allowed,
    vscode.ConfigurationTarget.Global,
  );
  const service = createCommandService(() => true);
  try {
    await service.search({ query: "issue40", maxResults: 100 });
    assert.equal(
      alpha.isActive,
      false,
      "Passive discovery cannot activate extensions",
    );
    assert.equal(beta.isActive, false);
    // The public API discovers registered runtime IDs. Set up independently
    // activated fixtures before testing discovery of their actual handlers.
    await alpha.activate();
    await beta.activate();
    const discovered = await service.search({
      query: "issue40",
      maxResults: 100,
    });
    assert.equal(discovered.incomplete, false);
    assert.ok(
      discovered.commands.some((item) =>
        item.metadata.some((meta) => meta.extensionId === alpha.id),
      ),
    );
    assert.ok(
      discovered.commands.some((item) =>
        item.metadata.some((meta) => meta.extensionId === beta.id),
      ),
    );
    assert.equal(alpha.exports.calls("complete"), 0);
    assert.equal(beta.exports.calls("complete"), 0);
    for (const commandId of ["issue40.alpha.prompt", "issue40.beta.prompt"]) {
      await assert.rejects(
        service.invoke({ commandId }),
        (error: unknown) =>
          (error as { code: string }).code === "COMMAND_UNSUPPORTED",
      );
    }
    assert.equal(alpha.exports.calls("prompt"), 0);
    assert.equal(beta.exports.calls("prompt"), 0);
    assert.equal(
      (await service.invoke({ commandId: "issue40.alpha.complete" }))
        .resultType,
      "boolean",
    );
    assert.equal(
      (await service.invoke({ commandId: "issue40.beta.complete" })).resultType,
      "number",
    );
    assert.equal(alpha.exports.calls("complete"), 1);
    assert.equal(beta.exports.calls("complete"), 1);
    assert.equal(alpha.exports.calls("prompt"), 0);
    assert.equal(beta.exports.calls("prompt"), 0);
    assert.equal(
      (await service.invoke({ commandId: "issue40.alpha.undefined" }))
        .resultType,
      "undefined",
    );
    for (const commandId of ["issue40.alpha.throw", "issue40.alpha.reject"]) {
      const result = await service.invoke({ commandId });
      assert.equal(result.outcome, "handler_failed");
      assert.equal(JSON.stringify(result).includes("secret"), false);
    }
    const opaque = await service.invoke({ commandId: "issue40.beta.opaque" });
    assert.equal(opaque.outcome, "handler_completed");
    assert.equal(opaque.resultOmitted, true);
    assert.equal(JSON.stringify(opaque).includes("secret"), false);
    await settings.update(
      "allowedCommands",
      [],
      vscode.ConfigurationTarget.Global,
    );
    await assert.rejects(
      service.invoke({ commandId: "issue40.alpha.complete" }),
      (error: unknown) =>
        (error as { code: string }).code === "COMMAND_NOT_AUTHORIZED",
    );
    assert.equal(alpha.exports.calls("complete"), 1);
    await settings.update(
      "allowedCommands",
      allowed,
      vscode.ConfigurationTarget.Global,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service.invoke(
        { commandId: "issue40.alpha.complete" },
        controller.signal,
      ),
    );
    assert.equal(alpha.exports.calls("complete"), 1);
    const pending = await Promise.all(
      Array.from({ length: 4 }, () =>
        service.invoke({ commandId: "issue40.alpha.hang", timeoutMs: 20 }),
      ),
    );
    assert.ok(
      pending.every((item) => item.outcome === "completion_unconfirmed"),
    );
    service.dispose();
    const restarted = createCommandService(() => true);
    try {
      await assert.rejects(
        restarted.invoke({ commandId: "issue40.alpha.complete" }),
        (error: unknown) => (error as { code: string }).code === "COMMAND_BUSY",
      );
      await vscode.commands.executeCommand("issue40.alpha.release");
      assert.equal(
        (await restarted.invoke({ commandId: "issue40.beta.complete" }))
          .resultType,
        "number",
      );
    } finally {
      restarted.dispose();
    }
    console.log(
      "Direct commands: two independent extension fixtures passed in the real host; no SAP compatibility claimed",
    );
  } finally {
    await vscode.commands.executeCommand("issue40.alpha.release");
    service.dispose();
    await settings.update(
      "allowedCommands",
      previous,
      vscode.ConfigurationTarget.Global,
    );
  }
}
