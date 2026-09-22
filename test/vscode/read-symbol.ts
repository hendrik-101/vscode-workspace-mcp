import assert from "node:assert/strict";
import * as vscode from "vscode";
import { WorkspaceService } from "../../src/workspace";
import { WorkspaceError, type Position } from "../../src/types";
import { MemoryProvider } from "./memory-provider";

/** Exercise the real command adapter, which normalizes legacy flat symbols. */
export async function readSymbolTools(
  provider: MemoryProvider,
  root: vscode.Uri,
) {
  const fullUri = vscode.Uri.joinPath(root, "read-symbol-body.txt");
  const flatUri = vscode.Uri.joinPath(root, "read-symbol-flat.txt");
  provider.seed(fullUri, "method {\n  body\n}\nafter");
  provider.seed(flatUri, "method {\n  body\n}\nafter");
  const service = new WorkspaceService();
  const registration = vscode.languages.registerDocumentSymbolProvider(
    { scheme: root.scheme, pattern: "**/read-symbol-*.txt" },
    {
      provideDocumentSymbols(document) {
        const identifier = new vscode.Range(0, 0, 0, 6);
        return document.uri.toString() === flatUri.toString()
          ? [
              new vscode.SymbolInformation(
                "method",
                vscode.SymbolKind.Method,
                "",
                new vscode.Location(document.uri, identifier),
              ),
            ]
          : [
              new vscode.DocumentSymbol(
                "method",
                "",
                vscode.SymbolKind.Method,
                new vscode.Range(0, 0, 2, 1),
                identifier,
              ),
            ];
      },
    },
  );
  try {
    const document = await vscode.workspace.openTextDocument(fullUri);
    let startPosition: Position | undefined;
    let collected = "";
    for (let page = 0; page < 20; page++) {
      const result = await service.readSymbol({
        uri: fullUri.toString(),
        version: document.version,
        name: "method",
        maxChars: 2,
        startPosition,
      });
      collected += result.text;
      assert.deepEqual(result.symbol.range, {
        start: { line: 0, character: 0 },
        end: { line: 2, character: 1 },
      });
      if (!result.truncated) break;
      startPosition = result.nextPosition;
    }
    assert.equal(collected, "method {\n  body\n}");
    const flatDocument = await vscode.workspace.openTextDocument(flatUri);
    await assert.rejects(
      service.readSymbol({
        uri: flatUri.toString(),
        version: flatDocument.version,
        name: "method",
      }),
      (error: unknown) =>
        error instanceof WorkspaceError &&
        error.code === "SYMBOL_RANGE_UNAVAILABLE",
    );
  } finally {
    registration.dispose();
    service.dispose();
  }
}
