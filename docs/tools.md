# Tool reference

Positions are zero-based UTF-16; ranges are end-exclusive. Use full workspace URIs.

`show_document` loads and reveals a complete workspace URI, optionally selecting
`selection: {start: {line, character}, end: {line, character}}`. Coordinates are
zero-based UTF-16 and the end is exclusive. `preserveFocus` defaults to `true`;
set it to `false` to focus the editor. Reading and editing do not implicitly show
an editor.

`workspace_symbols({query})` and `document_symbols({uri})` call VS Code's fixed
public provider commands, supporting both native extensions and LSP-backed
providers. Results default to 20 symbols (maximum 100), inspect at most 1,000
nodes, and report pagination and scan completeness. See
[symbol ranges, filters and paging](symbols.md). Names are capped at 1,000
characters. External,
unsafe, inaccessible and symlink targets are omitted. Empty results can mean no
matching symbols or no applicable provider; no ADT capability is assumed.

`show_diff` accepts `uri` and exactly one of `otherUri` or `proposedText`.
Proposals also require the current `version` from `read_document`. They use
immutable read-only content-provider URIs in memory, capped at 1 MiB each and
eight retained proposals per running bridge. Snapshots still opening are pinned;
when all eight are pending, another proposal fails with `LIMIT_EXCEEDED` until an
opening completes. Older completed proposals expire from the
provider; VS Code may retain already opened models until their tabs close.
Stopping the bridge releases the snapshot provider and its stored text. No
proposal is written to disk or applied. Comparing existing URIs opens VS Code's
normal diff editor; the user may manually edit its writable side.

`format_document({uri, version})` previews bounded `edits` by default. Optional
`range`, `tabSize` (1–32) and `insertSpaces` control generic formatting. Otherwise
resource-scoped editor settings supply the indentation defaults. Provider
selection follows VS Code's execute-provider commands and does not promise the
same formatter-picker behavior as the interactive Format Document command.
Language-specific formatting remains the installed provider's responsibility.
`apply: true` omits edits by default and returns document state, `applied` and
`editCount`. Set `includeEdits: true` to include the complete edits, or false for
a preview summary. Full previews retain the existing 1 MiB replacement-text
limit; see [formatting response size](formatting.md).
`apply: true` uses the same version, write-approval, trust, Auto Save and
cancellation checks as `edit_document`; it never implicitly saves. Preview
validates edit ranges, overlap and size too. Empty edits may mean the text is
already formatted or no formatter is available. Provider availability and
behavior with SAP ADT require acceptance testing on an actual backend.

`read_symbol({uri, version, name})` reads a unique provider-reported full body
with optional immediate `containerName` and identifier-start `position`.
It uses [bounded document pagination](reading.md); see [symbol reads](read-symbol.md)
for continuation, ambiguity and conservative full-range availability rules.

## Additional tools

- [Search filters and continuation](search.md)
- [Definitions, references and hover](navigation.md)
- [Rename and code action previews](refactoring.md)
- [Waiting for diagnostic events](diagnostics.md)
