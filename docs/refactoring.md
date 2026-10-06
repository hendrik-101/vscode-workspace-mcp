# Rename and code action previews

| Tool                   | Fixed VS Code command                  | Inputs                                                              |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `preview_rename`       | `vscode.executeDocumentRenameProvider` | Admitted URI, current version, zero-based UTF-16 position, new name |
| `preview_code_actions` | `vscode.executeCodeActionProvider`     | URI, version, selection, `quickfix` or `refactor` kind              |

Resolve at most 20 actions. Both tools work with writes disabled: neither edits,
saves, activates objects nor executes commands returned by providers.

## Validation

Previews include visible text edits with each buffer's URI, version and dirty
state. Every visible target must pass containment, symlink, size, exact-range and
overlap checks; one unsafe target rejects the request. Never filter a rename into
a smaller edit.

Reject observed target changes during the request, including provider calls,
close/reopen replacements and targets first opened during querying. Refresh dirty
states after authorization; dirty-only changes are allowed. Recheck roots/versions
after asynchronous work. Cancellation/stop discards results and immediately removes
observers even if providers never settle.

Initial snapshots and change/closure tracking each allow 1,000 document URIs and
256 KiB URI text. Snapshot overflow rejects before provider dispatch; tracking
overflow rejects the preview.

## Application is unsupported

Every preview reports `previewAvailable`: true when at least one visible text edit
is present, false for absent or empty text edits. This does not establish provider
availability or a complete operation. `applicationSupported: false` explicitly
states that application is unsupported. The existing `supported: false` remains
a compatibility alias for application support; `applicable: false` and
`complete: false` also remain. Reasons explain these limitations:

| Reason                  | Meaning                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPAQUE_WORKSPACE_EDIT` | Public `WorkspaceEdit.entries()` reveals only text edits; file, notebook, snippet or metadata operations may remain hidden. `size`, `get` and `has` cannot prove absence. |
| `COMMAND_REQUIRED`      | Legacy command or action requires a command; identifiers/arguments are neither exposed nor executed.                                                                      |
| `DISABLED`              | Provider disabled the action.                                                                                                                                             |
| `NO_EDIT`               | No resolved edit; unresolved, command-only, unavailable or unchanged operations are possible.                                                                             |

Even single-document, apparently text-only operations cannot be certified complete.
Do not inspect private fields or apply reconstructed text-only projections. Use
VS Code's native Rename/Quick Fix/Refactor UI and inspect the complete operation;
never copy an incomplete preview into `edit_document` as a substitute.
There is no apply tool/parameter, automated UI handoff or write/Trust/Auto Save bypass.

Empty results do not prove provider availability. Provider errors use the normal
redacted MCP boundary. Previews have no proposal IDs/apply tokens; request again
after changes. Providers may leave actions unresolved without edits.

## Limits

Per request: 20 actions, 500 document entries, 10,000 text edits, 8 MiB replacement
text plus repeated edit URIs; titles 512 characters, kinds 256, target text 8 MiB.
Document entries, edits and bytes are cumulative across all returned action previews.
Repeated entries for the same document count separately. Previews still cannot be
applied automatically; these larger bounds do not establish complete operations.
Full responses duplicate text in MCP's textual and structured envelopes and may
require a client receive buffer of up to 128 MiB. The SDK's default 10 MiB stdio
buffer does not accommodate every full preview; these bounds do not override
client-side limits.
Only excess action count sets `truncated`; other overflow rejects the request.

Source text has a separate budget: 128 MiB of UTF-8 text per request (the source
and unique targets), and 256 MiB across unfinished refactoring requests in this
bridge. Repeated targets across code actions count once for source bytes; each
concurrent request reserves its own budget. File metadata is checked before
opening additional targets, then actual decoded/live text is checked too.
Understated metadata can admit one extra document before the decoded check rejects
the request. Reservations are released on success/failure, but cancelling a
request does not free them while uncancellable provider work still runs.

`LIMIT_EXCEEDED` names the source budget, requested/allowed MiB and a remedy:
request a smaller operation or use VS Code's native Rename/Refactor UI. Concurrent
overflow asks the caller to wait for earlier provider work to finish. No partial
preview is returned. The bridge does not automatically close tabs or documents:
closing a tab does not guarantee VS Code releases a buffer. These are operation
budgets, not a total extension-host RAM cap; VS Code, providers, text projections
and already open documents require additional memory.

Synthetic non-file provider tests do not verify SAP backends, transports, locks
or activation; see [acceptance](acceptance.md).
API references: [provider commands](https://code.visualstudio.com/api/references/commands),
[WorkspaceEdit](https://code.visualstudio.com/api/references/vscode-api#WorkspaceEdit).
