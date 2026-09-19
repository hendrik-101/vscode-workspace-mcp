# Workspace MCP

A small MCP server **inside VS Code** for virtual workspaces and live editors.
MIT licensed. No telemetry. No shell tools. Independent of any AI client.

**Initial preview.** Designed for SAP ADT and other virtual filesystems. Synthetic
VFS tests cannot establish compatibility with a real SAP backend; that acceptance
test is still required. This project is not affiliated with SAP or OpenAI.

## Why

A local filesystem MCP cannot read a VS Code FileSystemProvider. Workspace MCP
keeps resource identifiers as full URIs and uses `workspace.fs`,
`workspace.openTextDocument` and `WorkspaceEdit`. Unsaved editor content is the
source of truth. SAP's own ADT MCP server supplies complementary ABAP operations;
configure it separately in your client. This extension neither bundles SAP code
nor stores SAP credentials.

## Install and connect

Requires **VS Code 1.137 or later**. The extension uses VS Code's bundled Node.js
runtime; a separate Node.js installation is only needed for development.

1. Download the `workspace-mcp-vsix` artifact from a successful GitHub Actions run,
   or build it below. In VS Code, run **Extensions: Install from VSIX**.
2. Open and trust your workspace, then run **Workspace MCP: Start**. Nothing
   starts implicitly.
3. Run **Workspace MCP: Show Connection Details** and select your client.
4. Copy the displayed **stdio** configuration into your client's **user** settings.
   It launches the bundled adapter with Node.js 24 or later and contains a private
   token: never commit or share it. Restart/reconnect the client. No certificate
   installation or HTTP-client setup is needed.
5. Ask the agent to list workspace roots and inspect the active editor.
6. With the default `ask` write policy, startup offers session-only or persistent
   write access; closing the prompt leaves the bridge read-only. The `allow` policy
   enables writes without a prompt; `deny` keeps the bridge read-only.

Turn **Auto Save off** for documents edited through MCP. Edits are refused while
Auto Save is enabled so that editing cannot implicitly persist a change.

The adapter connects internally over authenticated TLS. It verifies the generated
server certificate before transmitting credentials, so another local user cannot
steal the token by occupying the stopped server's port.

The fixed internal loopback port defaults to **39117** (`workspaceMcp.port` in User settings).
The token stays in VS Code SecretStorage across restarts; **Rotate Token** is the
only command that replaces it. The server certificate/private key also remain in
SecretStorage; **Rotate Server Identity** replaces those separately. Either
rotation requires updated client configuration. **Stop** closes the session,
retaining credentials.
`workspaceMcp.writePolicy` is `ask` by default, with `allow` and `deny` alternatives.
Port collisions fail explicitly; use a different user port for another window.
Loopback belongs to the extension host,
which may differ from your desktop when using SSH, WSL or containers.

[Client setup and optional Claude/Codex plugin](docs/clients.md).

## Tools

| Tool                | Behavior                                                              |
| ------------------- | --------------------------------------------------------------------- |
| `workspace_roots`   | Full workspace-folder URIs                                            |
| `editor_context`    | Scoped active editor, selection and open text tabs                    |
| `list_directory`    | Entries through `workspace.fs.readDirectory`                          |
| `read_document`     | Live text, version and dirty state; optional line range               |
| `search_workspace`  | Bounded, case-sensitive literal search through the provider           |
| `edit_document`     | Version-checked text edits; leaves the buffer unsaved                 |
| `save_document`     | Separate version-checked save; may trigger provider dialogs           |
| `get_diagnostics`   | Diagnostics already available in VS Code                              |
| `show_document`     | Reveal a document and optional selection; preserve focus by default   |
| `workspace_symbols` | Query installed workspace symbol providers; only admitted targets     |
| `document_symbols`  | Bounded document structure through installed language providers       |
| `show_diff`         | Compare two workspace documents or a versioned proposed text snapshot |
| `format_document`   | Preview provider formatting edits; optionally apply without saving    |

Positions are zero-based UTF-16; ranges are end-exclusive. Full URIs are required.
No create/delete/rename, arbitrary commands, activation or terminal tools in v0.1.
Search reports truncation/errors: it is not an exhaustive SAP repository index.

## Development

Node.js 24 LTS (use the latest 24.x patch):

```sh
npm ci
npm run check
npm test
npm run test:vscode
npm run format:check
npm run package
```

Linux extension-host tests require a display: `xvfb-run -a npm run test:vscode`.
The test runner downloads VS Code 1.137.0 for both the synthetic non-file
FileSystemProvider suite and SAP ADT coexistence checks. Set `VSCODE_VERSION` to
test another supported release. Node.js types and the bundle target stay on 24;
VS Code API types match the minimum supported VS Code version.
The VSIX is written to `artifacts/workspace-mcp.vsix`. CI builds that artifact on
every PR; it does **not** publish a Marketplace release.

Use short-lived `feat/`, `fix/`, `docs/` or `chore/` branches and PRs into `main`.
Main requires PRs, passing `verify` CI and resolved review conversations; administrators cannot bypass
the rule. Codex cloud reviews are configured separately from workflow YAML.
Review and merge deliberately; no auto-merge. See [design](docs/design.md),
[security](SECURITY.md) and [manual acceptance](docs/acceptance.md).

## IDE and language tools

`show_document` loads and reveals a complete workspace URI, optionally selecting
`selection: {start: {line, character}, end: {line, character}}`. Coordinates are
zero-based UTF-16 and the end is exclusive. `preserveFocus` defaults to `true`;
set it to `false` to focus the editor. Reading and editing do not implicitly show
an editor.

`workspace_symbols({query})` and `document_symbols({uri})` call VS Code's fixed
public provider commands, supporting both native extensions and LSP-backed
providers. Results contain at most 100 symbols, inspect at most 1,000 nodes, and
report `truncated` and `omitted`. Names are capped at 1,000 characters. External,
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
`apply: true` uses the same version, write-approval, trust, Auto Save and
cancellation checks as `edit_document`; it never implicitly saves. Preview
validates edit ranges, overlap and size too. Empty edits may mean the text is
already formatted or no formatter is available. Provider availability and
behavior with SAP ADT require acceptance testing on an actual backend.
