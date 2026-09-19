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

1. Download the `workspace-mcp-vsix` artifact from a successful GitHub Actions run,
   or build it below. In VS Code, run **Extensions: Install from VSIX**.
2. Open your workspace and run **Workspace MCP: Start**. Nothing starts implicitly.
3. Run **Workspace MCP: Show Connection Details** and select your client.
4. Copy the displayed configuration into your client's **user** settings. It
   contains a private token: never commit or share it. Restart/reconnect the client.
5. Ask the agent to list workspace roots and inspect the active editor.
6. When ready, run **Workspace MCP: Enable Writes for This Session** in VS Code.

Turn **Auto Save off** for documents edited through MCP. Edits are refused while
Auto Save is enabled so that editing cannot implicitly persist a change.

Each running window gets its own random port/token. **Stop** invalidates the token;
after restarting, refresh client settings. Loopback belongs to the extension host,
which may differ from your desktop when using SSH, WSL or containers.

[Client setup and optional Claude/Codex plugin](docs/clients.md).

## Tools

| Tool               | Behavior                                                    |
| ------------------ | ----------------------------------------------------------- |
| `workspace_roots`  | Full workspace-folder URIs                                  |
| `editor_context`   | Scoped active editor, selection and open text tabs          |
| `list_directory`   | Entries through `workspace.fs.readDirectory`                |
| `read_document`    | Live text, version and dirty state; optional line range     |
| `search_workspace` | Bounded, case-sensitive literal search through the provider |
| `edit_document`    | Version-checked text edits; leaves the buffer unsaved       |
| `save_document`    | Separate version-checked save; may trigger provider dialogs |
| `get_diagnostics`  | Diagnostics already available in VS Code                    |

Positions are zero-based UTF-16; ranges are end-exclusive. Full URIs are required.
No create/delete/rename, arbitrary commands, activation or terminal tools in v0.1.
Search reports truncation/errors: it is not an exhaustive SAP repository index.

## Development

Node.js 22 or later:

```sh
npm ci
npm run check
npm test
npm run test:vscode
npm run format:check
npm run package
```

Linux extension-host tests require a display: `xvfb-run -a npm run test:vscode`.
The test runner downloads VS Code and uses a synthetic non-file FileSystemProvider.
The VSIX is written to `artifacts/workspace-mcp.vsix`. CI builds that artifact on
every PR; it does **not** publish a Marketplace release.

Use short-lived `feat/`, `fix/`, `docs/` or `chore/` branches and PRs into `main`.
Main requires PRs, passing `verify` CI and resolved review conversations; administrators cannot bypass
the rule. Codex cloud reviews are configured separately from workflow YAML.
Review and merge deliberately; no auto-merge. See [design](docs/design.md),
[security](SECURITY.md) and [manual acceptance](docs/acceptance.md).
