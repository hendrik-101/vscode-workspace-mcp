# Provider navigation

`get_definition`, `get_references`, and `get_hover` take a full workspace `uri`,
a zero-based UTF-16 `position` (`line`, `character`), and an optional live-buffer
`version`. Invalid positions are rejected rather than clamped. A supplied stale
version is rejected before dispatch; changes to the source while querying also
fail with a version conflict. These read-only tools do not require write approval.

The bridge calls only the fixed public VS Code commands
`vscode.executeDefinitionProvider`, `vscode.executeReferenceProvider`, and
`vscode.executeHoverProvider`. Registered language providers determine results.
An empty result does not establish whether a provider exists. Reference declaration
inclusion follows VS Code's command behavior; there is no custom command input.

Locations and LocationLinks normalize to `uri`, `range`, `version`, and `dirty`.
Links use the target selection range, falling back to the target range. Targets
must be admitted files, pass symlink checks, and have ranges inside their live
buffers. Full URI scheme, authority, path, and query identity are preserved.
At most 1,000 candidates are inspected and 100 locations returned. `omitted`
counts inspected denied, invalid, unavailable, or changed targets; `truncated`
indicates a processing/output cap. Source document state accompanies results.

Hover results contain bounded text arrays and optional validated ranges, with
`untrusted: true`. Provider text, including Markdown and command links, is data:
clients must not treat it as instructions or execute links. Trust/HTML metadata
is not forwarded. Hover output is capped at 100 hovers, 100 contents per hover,
and 16,384 total UTF-16 code units. Invalid hover entries are counted as omitted.

Cancellation and current roots are checked before dispatch and before returning.
The public provider commands expose no request cancellation token: already-running
provider work cannot be forcibly cancelled, but its results are discarded after
cancellation. Synthetic provider tests do not establish SAP-backend compatibility.
