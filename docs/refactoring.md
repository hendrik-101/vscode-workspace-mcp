# Provider rename and code action previews

`preview_rename` calls the fixed `vscode.executeDocumentRenameProvider` API with
an admitted document URI, current version, zero-based UTF-16 position and new
name. `preview_code_actions` calls `vscode.executeCodeActionProvider` with the
URI, version, selection and `quickfix` or `refactor` kind. Up to 20 actions are
resolved. Neither tool edits, saves, activates backend objects or executes a
command returned by a provider. They work while bridge writes are disabled.

The result reports provider-derived text edits across multiple admitted files,
including each live buffer's URI, version and dirty state. All visible targets
must pass containment, symlink, size, exact-range and overlap validation; one
unsafe target rejects the whole request. A rename is never filtered into a
smaller edit. Changes to any observed target during the request reject the
preview, including changes during the provider call and same-version document
replacement after close/reopen, even when the provider first opened the target
during the query. Dirty-state-only changes are allowed; returned
dirty states are refreshed after all authorization finishes. Roots and versions are
checked again after all asynchronous work. Cancellation and stopped sessions
also discard pending results. Change observers are released immediately on
cancellation or session stop, even when a provider never settles. Tracking is
capped at 1000 changed or closed document URIs and 256 KiB of URI text; overflow rejects
the preview. The initial version snapshot is also bounded to 1000 open documents
and 256 KiB of URI text, checked before dispatching a provider.

## Application limitation

Every preview reports `supported: false`, `applicable: false`, `complete: false`
and a reason. These fields describe **automatic application of the provider
operation**, not whether text can be previewed. `OPAQUE_WORKSPACE_EDIT` means
public `WorkspaceEdit.entries()` exposes only text edits, while file, notebook,
snippet or metadata operations may also exist. `size`, `get` and `has` cannot
prove their absence. Even apparently text-only, single-document operations
cannot safely be certified as complete through these public APIs. We neither
inspect private VS Code fields nor apply a reconstructed text-only projection.

`COMMAND_REQUIRED` additionally marks a legacy command or code action with a
command; its identifier and arguments are never returned or executed. `DISABLED`
marks a disabled action. `NO_EDIT` means no resolved edit was returned; the action
may be unresolved, command-only, unavailable or have no changes. Empty rename or
action results do not establish whether a provider is installed. Provider error
messages are redacted by the ordinary MCP error boundary.

To perform a rename or action, use VS Code's native Rename or Quick Fix/Refactor
UI and inspect its complete changes there. Do not copy these incomplete previews
into `edit_document` as a substitute for applying the complete provider operation.
No application tool or `apply` parameter is offered, so there is no path around
write approval, Trust or Auto Save policy. Native UI handoff is not automated.

## Bounds and scope

One request returns at most 20 actions, 20 document entries across all actions, 100 text edits
across all returned actions, and 256 KiB of replacement text and repeated edit
URIs. Titles are capped at 512 characters and kinds at 256. Excess action count
sets `truncated`; other overflow rejects the request instead of returning a
partial operation. Text target documents retain the ordinary 1 MiB limit.
Previews are immediate observations with no cached proposal IDs or apply tokens.
Re-request after any change. Provider implementations control resolution and
may return no edit for an unresolved action.

These are generic provider APIs, with synthetic non-file integration tests.
No SAP backend, transports, locks or activation behavior is claimed as verified.

References: [VS Code built-in provider commands](https://code.visualstudio.com/api/references/commands)
and [public WorkspaceEdit API](https://code.visualstudio.com/api/references/vscode-api#WorkspaceEdit).
