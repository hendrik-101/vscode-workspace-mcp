# Reading a symbol

`read_symbol` reads the provider-reported full body of one symbol from an
admitted live document, without editing, showing or saving. Required inputs are
`uri`, `version`, and exact `name` (1–4096 UTF-16 code units). Optional
`containerName` selects the immediate parent; an empty string selects actual
top-level symbols. Traversal retains parent provenance: a nested symbol with a
missing, empty or malformed parent name cannot be treated as top-level or ruled
out by a named-container filter. If its other selectors may match, resolution
fails with `SYMBOL_RANGE_UNAVAILABLE`. `position` must equal the identifier's
`selectionRange.start`, allowing overload disambiguation. All
positions are zero-based UTF-16. Selectors are scoped to the requested URI.

Every call executes `vscode.executeDocumentSymbolProvider` directly and inspects
at most 1000 nodes. Resolution must finish: overflow fails with
`SYMBOL_RESOLUTION_INCOMPLETE`, even if an apparent unique match was already
found. Non-object provider entries are skipped. Malformed location URIs fail with
`SYMBOL_RANGE_UNAVAILABLE` only when the available name, container and identifier
start cannot exclude the candidate; valid locations for other URIs are excluded.
An unrelated parent's malformed location does not hide its matching children.
Never choose the first duplicate. `SYMBOL_NOT_FOUND` means no matching
provider result, not proof that no provider exists; `SYMBOL_AMBIGUOUS` requires a
more precise selector. Flat `SymbolInformation` locations cannot establish a
body: matching flat results, malformed full ranges, and invalid or uncontained
selection ranges fail with `SYMBOL_RANGE_UNAVAILABLE`. All four full/selection
range endpoints must lie on Unicode scalar boundaries; provider positions inside
a surrogate pair are unavailable, including on continuation calls. An unusable
provider identifier start cannot rule out a possible overload. Provider errors remain
redacted by the MCP boundary. VS Code normalizes flat results into symbols whose
full and selection ranges are identical. This indistinguishable shape is also
rejected, including genuine symbols with identical ranges. Use `read_document`
with an explicit range for those symbols; no body extent is guessed.

Use exact `DocumentSymbol.range`, never infer its extent from neighboring
symbols, identifier locations or workspace search. Capture the document
instance and required version before the provider call; reject edits, closes
and replacement instances with `VERSION_CONFLICT`. Recheck cancellation,
workspace admission and bridge activity before dispatch and before responding.

Optional `startPosition` resumes within the selected full range, including its
end for an empty final page. It cannot precede the body, extend beyond its end, or
split a surrogate pair. Supplied `position` and `startPosition` are checked against
the live document and surrogate boundaries before provider dispatch; invalid
caller positions return `INVALID_ARGUMENT` regardless of provider availability or
ambiguity. Continuation containment within the selected body is checked after
symbol resolution.
`maxLines` and `maxChars` use the same limits and defaults as
[bounded document reads](reading.md). The implementation calls
`WorkspaceService.read` with the selected residual range, expected version and
budgets, then rechecks document identity. The result contains all read fields
plus `symbol: {name, kind, containerName?, range, selectionRange}`. Metadata names
are capped at 1000 characters; matching always uses untruncated provider names.

Continue by repeating the exact URI, version and symbol selector, passing the
returned `nextPosition` as `startPosition`. Provider resolution repeats on every
page; ranges are provider observations, not an atomic multi-page snapshot.
Provider availability and full-range fidelity depend on the installed language
extension; SAP ADT behavior requires backend acceptance testing.

## Implementation steps

1. Add failing tests for bodies, exact overload/parent selection, flat results,
   incomplete traversal, invalid ranges, stale/reopened documents, virtual URIs,
   residual pages and MCP schema/error redaction.
2. Add the public contract, bounded resolver and MCP registration. Delegate text
   slicing to `read`; retain identity/version guards around asynchronous work.
3. Run type, format, full runtime tests, package and production audit checks;
   separately review simplification. Native VS Code and current-head PR gates
   are completed by the integration owner.
