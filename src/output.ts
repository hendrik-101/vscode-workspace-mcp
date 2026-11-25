import * as vscode from "vscode";

export type OutputRead =
  | { status: "not_shared" | "not_visible" }
  | {
      status: "available";
      text: string;
      truncated: boolean;
      version: number;
    };

export class OutputSharing {
  private sharedUri: string | undefined;

  candidates(): vscode.TextDocument[] {
    const active = vscode.window.activeTextEditor;
    const documents = new Map<string, vscode.TextDocument>();
    for (const editor of [
      ...vscode.window.visibleTextEditors,
      ...(active ? [active] : []),
    ]) {
      const document = editor.document;
      if (document.uri.scheme === "output" && !document.isClosed)
        documents.set(document.uri.toString(), document);
    }
    return [...documents.values()];
  }

  share(document: vscode.TextDocument): boolean {
    if (!this.candidates().includes(document)) return false;
    this.sharedUri = document.uri.toString();
    return true;
  }

  clear(): void {
    this.sharedUri = undefined;
  }

  read(maxChars: number): OutputRead {
    if (!this.sharedUri) return { status: "not_shared" };
    const document = this.candidates().find(
      (candidate) => candidate.uri.toString() === this.sharedUri,
    );
    if (!document) return { status: "not_visible" };
    const end = document.lineAt(document.lineCount - 1).range.end;
    const endOffset = document.offsetAt(end);
    const start = document.positionAt(Math.max(0, endOffset - maxChars));
    let text = document.getText(new vscode.Range(start, end)).slice(-maxChars);
    if (/^[\udc00-\udfff]/u.test(text)) text = text.slice(1);
    return {
      status: "available",
      text,
      truncated: endOffset > maxChars,
      version: document.version,
    };
  }
}
