import assert from "node:assert/strict";
import test from "node:test";
import { Uri, Position, Range } from "./support/values";
import { loadWorkspace } from "./support/workspace";
import { makeDocument } from "./support/document";

function loadService(vscode: unknown) {
  const WorkspaceService = loadWorkspace(vscode);
  return new WorkspaceService(() => true);
}

class WorkspaceEdit {
  edits: { range: Range; text: string }[] = [];
  replace(_uri: Uri, range: Range, text: string) {
    this.edits.push({ range, text });
  }
}

// Exercise the real formatting and guarded edit path with a minimal VS Code API.
test("format summaries omit large edits without dropping the buffer mutation", async () => {
  const root = Uri.parse("vfs:/project");
  const uri = Uri.parse("vfs:/project/main");
  let text = "messy";
  const replacement = "x".repeat(100_000);
  let supplied = true;
  const document = {
    uri,
    version: 1,
    isDirty: false,
    isClosed: false,
    lineCount: 1,
    getText: () => text,
    offsetAt: (position: Position) => position.character,
    lineAt: () => ({
      text,
      range: new Range(new Position(0, 0), new Position(0, text.length)),
    }),
  };
  const service = loadService({
    Uri,
    Position,
    Range,
    WorkspaceEdit,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: root }],
      textDocuments: [document],
      fs: {
        stat: async (value: Uri) => ({
          type: value.toString() === root.toString() ? 2 : 1,
          size: text.length,
        }),
      },
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      applyEdit: async (edit: WorkspaceEdit) => {
        for (const item of edit.edits)
          text =
            text.slice(0, item.range.start.character) +
            item.text +
            text.slice(item.range.end.character);
        document.version++;
        document.isDirty = true;
        return true;
      },
    },
    commands: {
      executeCommand: async () =>
        supplied
          ? [{ range: document.lineAt().range, newText: replacement }]
          : [],
    },
  });
  try {
    const preview = await service.format({ uri: uri.toString(), version: 1 });
    assert.equal(preview.editCount, 1);
    assert.equal(preview.edits?.[0]?.text, replacement);
    const result = await service.format({
      uri: uri.toString(),
      version: 1,
      apply: true,
    });
    assert.equal(text, replacement);
    assert.equal(result.version, 2);
    assert.equal(result.dirty, true);
    assert.equal(result.applied, true);
    assert.equal(result.editCount, 1);
    assert.equal("edits" in result, false);
    assert.ok(JSON.stringify(result).length < 200);
    assert.ok(JSON.stringify(preview).length > 100_000);
    const included = await service.format({
      uri: uri.toString(),
      version: 2,
      apply: true,
      includeEdits: true,
    });
    assert.equal(included.edits?.[0]?.text, replacement);
    const summary = await service.format({
      uri: uri.toString(),
      version: 3,
      includeEdits: false,
    });
    assert.equal("edits" in summary, false);
    assert.equal(summary.applied, false);
    assert.equal(summary.editCount, 1);
    supplied = false;
    const empty = await service.format({
      uri: uri.toString(),
      version: 3,
      apply: true,
    });
    assert.equal(empty.editCount, 0);
    assert.equal(empty.applied, false);
    assert.equal("edits" in empty, false);
    assert.equal(document.version, 3);
  } finally {
    service.dispose();
  }
});

test("formatting applies 10000 independent edits above one MiB without saving", async () => {
  const uri = Uri.parse("vfs:/project/main");
  const document = makeDocument(uri, "x\n".repeat(10000));
  let supplied = Array.from({ length: 10000 }, (_, line) => ({
    range: new Range(new Position(line, 0), new Position(line, 0)),
    newText: " ".repeat(128),
  }));
  const service = loadService({
    Uri,
    Position,
    Range,
    WorkspaceEdit,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: Uri.parse("vfs:/project") }],
      textDocuments: [document],
      fs: {
        stat: async (value: Uri) => ({
          type: value.path === "/project" ? 2 : 1,
          size: document.getText().length,
        }),
      },
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      applyEdit: async (edit: WorkspaceEdit) => {
        const original = document.getText();
        const parts: string[] = [];
        let previous = 0;
        for (const item of edit.edits) {
          const start = document.offsetAt(item.range.start);
          parts.push(original.slice(previous, start), item.text);
          previous = document.offsetAt(item.range.end);
        }
        parts.push(original.slice(previous));
        const version = document.version + 1;
        Object.assign(document, makeDocument(uri, parts.join("")), { version });
        return true;
      },
    },
    commands: { executeCommand: async () => supplied },
  });
  try {
    const result = await service.format({
      uri: uri.toString(),
      version: 2,
      apply: true,
    });
    assert.equal(result.editCount, 10000);
    assert.equal(result.applied, true);
    assert.equal(result.version, 3);
    assert.equal("edits" in result, false);
    assert.equal(document.getText(), `${" ".repeat(128)}x\n`.repeat(10000));
    assert.equal(
      (await service.read({ uri: uri.toString(), maxLines: 1 })).text,
      `${" ".repeat(128)}x\n`,
    );
    supplied = [...supplied, supplied[0]!];
    await assert.rejects(
      service.format({ uri: uri.toString(), version: 3, apply: true }),
      { code: "LIMIT_EXCEEDED" },
    );
    assert.equal(document.version, 3);
  } finally {
    service.dispose();
  }
});
