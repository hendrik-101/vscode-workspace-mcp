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

Per request: 20 actions, 20 document entries, 100 text edits, 256 KiB replacement
text plus repeated edit URIs; titles 512 characters, kinds 256, target text 1 MiB.
Only excess action count sets `truncated`; other overflow rejects the request.

Synthetic non-file provider tests do not verify SAP backends, transports, locks
or activation; see [acceptance](acceptance.md).
API references: [provider commands](https://code.visualstudio.com/api/references/commands),
[WorkspaceEdit](https://code.visualstudio.com/api/references/vscode-api#WorkspaceEdit).
