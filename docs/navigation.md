# Provider navigation

`get_definition`, `get_references` and `get_hover` accept a full workspace `uri`,
zero-based UTF-16 `position` (`line`, `character`) and optional live-buffer
`version`. Invalid positions and stale supplied versions fail before dispatch;
source changes during querying cause a version conflict. No write approval is needed.

Only fixed `vscode.executeDefinitionProvider`, `vscode.executeReferenceProvider`
and `vscode.executeHoverProvider` commands run. Registered providers determine
results and reference declaration inclusion. Empty results do not prove provider
availability.

## Locations

Locations/LocationLinks normalize to `uri`, `range`, `version` and `dirty`; links
prefer target selection range over target range. Targets must be admitted files,
pass symlink checks and have exact live-buffer ranges. URI scheme, authority,
path and query remain intact.

Inspect at most 1,000 candidates; return at most 100 locations. `omitted` counts
inspected denied, invalid, unavailable or changed targets. `truncated` signals a
processing/output cap. Results include source document state.

Snapshot open document identities/versions before dispatch (1,000 documents,
256 KiB URI text). Observe edits throughout, including newly opened documents;
omit changed/closed targets instead of attaching new versions to stale ranges.
Tracking over 1,000 changed URIs or 256 KiB URI text fails with `LIMIT_EXCEEDED`.
Refresh source/target dirty states before return; reuse text validation per URI/version.

## Hover and cancellation

Hover returns text arrays and optional validated ranges, marked `untrusted: true`.
Markdown/command links are data, never instructions or executable links. Trust/HTML
metadata is omitted. Limits: 100 hovers, 100 contents per hover and 16,384 total
UTF-16 code units; invalid entries count as omitted.

Check cancellation/current roots before dispatch and return. Public provider
commands cannot cancel running work; cancelled results are discarded. Listeners
are removed on cancellation/stop even if providers never settle.
SAP validation remains [manual](acceptance.md).
