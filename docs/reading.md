# Bounded document reads

`read_document` reads the current live buffer without saving. Use either the
existing zero-based half-open `startLine` / `endLine` selectors (defaults: zero
and document line count), or an exact half-open `range: { start, end }` of
zero-based UTF-16 `{ line, character }` positions. Mixing modes, reversed or
out-of-bounds ranges, and positions inside a surrogate pair are rejected, never
clamped. Exact positions end at line text length; they cannot address the middle
of CRLF. Empty ranges and EOF are valid. In line mode the line-count sentinel
maps to the last line's end.

Optional `version` must equal the live buffer version. Every response includes
the observed version. Read pages are individually checked observations; pass
that version on subsequent pages to reject intervening edits in the same open
document. Versions may reset on close/reopen, so they are not persistent snapshot
identities across reopen.

Both budgets apply to each response: `maxLines` defaults to 200 (1–1000) and
`maxChars` defaults to 16000 (2–64000 UTF-16 code units, including line endings).
A source line counts when its text or terminator is returned; an end position
at the next line's character zero does not count that next line. A partial first
line counts as one. The two-character minimum guarantees forward progress for
surrogate pairs and CRLF, which are never split. Budgets bound response text;
the existing 1 MiB document admission limit still applies.

The response retains `uri`, `version`, `dirty`, `languageId`, `lineCount`, `text`,
`startLine`, and `endLine`. Legacy `startLine` / `endLine` describe the requested
line envelope, not necessarily all returned text: line-mode values retain the
original/default selectors; exact-range values enclose the requested lines
(empty range: both equal the start line). `requestedRange` and `returnedRange`
are exact positions. `text` is precisely the buffer slice at `returnedRange`.
`truncated` is true exactly when the requested range has unread text;
`nextPosition` is present only then, equal to `returnedRange.end`.

To continue, call `read_document` with the same URI, returned `version`, and
`range: { start: nextPosition, end: requestedRange.end }`. Repeat budgets if
desired. This also resumes within a long single line. A final page omits
`nextPosition` and sets `truncated: false`. Workspace membership and version are
checked again immediately before responding.

## Implementation steps

1. Add regression tests for exact ranges, both budgets, residual continuation,
   CRLF/surrogate boundaries, empty/EOF requests, validation and stale reads.
2. Extend the public read types and MCP schema; implement bounds in reusable
   `WorkspaceService.read(input)` for callers including future symbol reads.
3. Verify types, formatting, full tests, VS Code integration, packaging and
   production dependency audit. Review the diff separately for simplification.
