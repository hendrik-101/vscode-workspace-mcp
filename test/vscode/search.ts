import assert from "node:assert/strict";
import * as vscode from "vscode";
import { WorkspaceService } from "../../src/workspace";
import { MemoryProvider } from "./memory-provider";

/** Real non-file URI traversal and live buffer continuation in the extension host. */
export async function progressiveSearch(
  provider: MemoryProvider,
  parent: vscode.Uri,
): Promise<void> {
  const root = vscode.Uri.joinPath(parent, "progressive-search");
  provider.seed(root, "", vscode.FileType.Directory);
  const many = vscode.Uri.joinPath(root, "many.ts");
  const matchCount = 251;
  provider.seed(many, "stored text");
  for (let i = 0; i < 251; i++)
    provider.seed(vscode.Uri.joinPath(root, `file${i}.txt`), "absent");
  const document = await vscode.workspace.openTextDocument(many);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    many,
    new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    ),
    "needle\n".repeat(matchCount),
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  const service = new WorkspaceService();
  try {
    const input = { uri: root.toString(), query: "needle", include: ["*.ts"] };
    const defaultPageSize = 20;
    const expectedPages = Math.ceil(matchCount / defaultPageSize);
    let page = await service.search(input);
    const lines: number[] = [];
    for (let pages = 0; ; pages++) {
      assert.ok(
        pages < expectedPages,
        "search must finish within its expected pages",
      );
      assert.equal(
        page.matches.length,
        Math.min(defaultPageSize, matchCount - lines.length),
        "short matches must use the default page size until the final page",
      );
      lines.push(
        ...page.matches.map((match) => {
          assert.equal(match.uri, many.toString());
          return match.line;
        }),
      );
      if (!page.nextCursor) break;
      page = await service.search({ ...input, cursor: page.nextCursor });
    }
    assert.deepEqual(
      lines,
      Array.from({ length: matchCount }, (_, line) => line),
    );
    assert.equal(page.incomplete, false);
    assert.equal(provider.stored(many), "stored text");
    const filesInput = { uri: root.toString(), query: "not-present" };
    const first = await service.search(filesInput);
    assert.equal(first.filesSearched, 200);
    assert.ok(first.nextCursor);
    const last = await service.search({
      ...filesInput,
      cursor: first.nextCursor,
    });
    assert.equal(last.filesSearched, 52);
    assert.equal(last.incomplete, false);
    await assert.rejects(service.search(input, AbortSignal.abort()));
    const pending = await service.search(input);
    const change = new vscode.WorkspaceEdit();
    change.insert(many, new vscode.Position(0, 0), "changed ");
    assert.equal(await vscode.workspace.applyEdit(change), true);
    await assert.rejects(
      service.search({ ...input, cursor: pending.nextCursor }),
      /changed/,
    );
  } finally {
    service.dispose();
  }
}
