import assert from "node:assert/strict";
import * as vscode from "vscode";
import { WorkspaceService } from "../../src/workspace";
import { MemoryProvider } from "./memory-provider";

export async function navigationTools(
  provider: MemoryProvider,
  root: vscode.Uri,
  outside: vscode.Uri,
): Promise<void> {
  const file = vscode.Uri.joinPath(root, "navigation.txt");
  provider.seed(file, "original");
  const document = await vscode.workspace.openTextDocument(file);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(file, new vscode.Position(0, 0), "live ");
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  const selector = { scheme: file.scheme, pattern: "**/navigation.txt" };
  const full = new vscode.Range(0, 0, 0, 4);
  const registrations = [
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(doc) {
        assert.equal(doc.getText(), "live original");
        return [
          {
            targetUri: file,
            targetRange: full,
            targetSelectionRange: new vscode.Range(0, 1, 0, 3),
          },
          { targetUri: outside, targetRange: full },
        ];
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences() {
        return [
          new vscode.Location(file, full),
          new vscode.Location(outside, full),
        ];
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover() {
        const text = new vscode.MarkdownString(
          "Provider **hover** [link](command:unsafe)",
        );
        text.isTrusted = true;
        return new vscode.Hover(text, full);
      },
    }),
  ];
  const service = new WorkspaceService();
  try {
    const input = {
      uri: file.toString(),
      position: { line: 0, character: 2 },
      version: document.version,
    };
    const definitions = await service.definition(input);
    assert.equal(definitions.locations.length, 1);
    assert.equal(definitions.locations[0]?.range.start.character, 1);
    assert.equal(definitions.locations[0]?.dirty, true);
    assert.equal(definitions.omitted, 1);
    const references = await service.references(input);
    assert.equal(references.locations.length, 1);
    assert.equal(references.omitted, 1);
    const hover = await service.hover(input);
    assert.equal(hover.untrusted, true);
    assert.match(hover.hovers[0]?.contents[0] ?? "", /Provider \*\*hover\*\*/);
  } finally {
    service.dispose();
    registrations.forEach((item) => item.dispose());
  }
}
