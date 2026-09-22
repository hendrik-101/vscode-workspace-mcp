import type { Position as DocumentPosition } from "../../src/types";
import { Uri, Position, Range } from "./values";

export function makeDocument(uri: Uri, text: string, onRead = () => {}) {
  const lines = text.split(/\r\n|\n|\r/);
  const starts = [0];
  for (const match of text.matchAll(/\r\n|\n|\r/g))
    starts.push(match.index! + match[0].length);
  return {
    uri,
    version: 2,
    isDirty: true,
    isClosed: false,
    languageId: "text",
    lineCount: lines.length,
    lineAt(line: number) {
      return {
        text: lines[line]!,
        range: new Range(
          new Position(line, 0),
          new Position(line, lines[line]!.length),
        ),
      };
    },
    offsetAt(p: DocumentPosition) {
      return starts[p.line]! + p.character;
    },
    positionAt(offset: number) {
      let line = starts.length - 1;
      while (starts[line]! > offset) line--;
      return new Position(
        line,
        Math.min(offset - starts[line]!, lines[line]!.length),
      );
    },
    getText(value?: Range) {
      onRead();
      return value
        ? text.slice(this.offsetAt(value.start), this.offsetAt(value.end))
        : text;
    },
  };
}
