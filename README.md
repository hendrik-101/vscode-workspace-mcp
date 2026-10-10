# Workspace MCP

<!-- prettier-ignore -->
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/hendrik-101/vscode-workspace-mcp?utm_source=oss&amp;utm_medium=github&amp;utm_campaign=hendrik-101%2Fvscode-workspace-mcp&amp;labelColor=171717&amp;color=FF570A&amp;link=https%3A%2F%2Fcoderabbit.ai&amp;label=CodeRabbit+Reviews)](https://coderabbit.ai)

Connect MCP clients such as Codex and Claude Code to the workspace open in VS Code,
including virtual filesystems such as SAP ADT. Read live editor content, inspect
symbols and diagnostics, and apply edits without saving automatically.

Unlike a local filesystem server, this extension uses VS Code's workspace APIs
and preserves full URIs. Unsaved editor changes are included in reads.

MIT licensed. No telemetry or shell tools. **Initial preview:** compatibility with
a real SAP backend still requires [acceptance testing](docs/acceptance.md).
Independent project, not affiliated with SAP or OpenAI.

## Install and connect

Requires **VS Code 1.137+** and **Node.js 24+** on the MCP client host.
The client must be able to run the bundled adapter in the same network environment
as the VS Code extension host; hosted web sessions cannot connect directly.

1. Once published, install **Workspace MCP** from publisher **hendrik101** from the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=hendrik101.vscode-workspace-mcp)
   (extension ID `hendrik101.vscode-workspace-mcp`; select the pre-release channel
   for the initial preview). Until the first publication, open a successful [CI run on main](https://github.com/hendrik-101/vscode-workspace-mcp/actions/workflows/ci.yml?query=branch%3Amain),
   download the `workspace-mcp-vsix-Linux`, `-Windows` or `-macOS` artifact and extract the ZIP. GitHub sign-in
   is required. Alternatively, [build the VSIX](#build-from-source).
2. If using a downloaded or locally built VSIX, run **Extensions: Install from VSIX**
   in the VS Code Command Palette and select
   `workspace-mcp.vsix`.
3. Open and trust your workspace. Turn **Files: Auto Save** off before allowing
   agent edits; the bridge refuses edits when Auto Save is enabled.
4. Run **Workspace MCP: Start**. By default, it asks for write permission;
   dismissing the prompt keeps the bridge read-only. Editing and saving are
   separate operations.
5. Run **Workspace MCP: Show Connection Details**, select your client and copy
   the generated **stdio** configuration into its private user settings.
   It contains a secret token: never commit or share it. Restart the client connection.
6. Ask the agent to list workspace roots and read the active document.

Use **Workspace MCP: Stop** to disconnect. See [client setup](docs/clients.md)
for client-specific instructions, write policies, ports and remote-host limitations.
CI artifacts expire after 14 days. [Versioned releases](docs/releases.md) attach a
VSIX and checksum to GitHub Releases and publish the same tested file to Marketplace
after the owner pushes a release tag. The manual preview workflow remains available
for inspecting a draft before the first public release.

## Build from source

Requires Git and Node.js 24 LTS with npm (use the latest 24.x patch).

```sh
git clone https://github.com/hendrik-101/vscode-workspace-mcp.git
cd vscode-workspace-mcp
npm ci
npm run package
```

Install the resulting `artifacts/workspace-mcp.vsix` using the steps above.

## Tools

| Tool                                            | Behavior                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `workspace_roots`                               | Full workspace-folder URIs                                               |
| `editor_context`                                | Scoped active editor, selection and open text tabs                       |
| `list_directory`                                | Entries through `workspace.fs.readDirectory`                             |
| `read_document`                                 | Live text, version and dirty state; optional line range                  |
| `read_symbol`                                   | Version-checked symbol bodies with bounded continuation                  |
| `search_workspace`                              | Bounded literal search with filters and continuation cursors             |
| `edit_document`                                 | Version-checked text edits; leaves the buffer unsaved                    |
| `save_document`                                 | Separate version-checked save; may trigger provider dialogs              |
| `get_diagnostics`                               | Diagnostics already available in VS Code                                 |
| `show_document`                                 | Reveal a document and optional selection; preserve focus by default      |
| `workspace_symbols`                             | Query installed workspace symbol providers; only admitted targets        |
| `document_symbols`                              | Bounded document structure through installed language providers          |
| `show_diff`                                     | Compare two workspace documents or a versioned proposed text snapshot    |
| `format_document`                               | Preview provider formatting edits; optionally apply without saving       |
| `wait_for_diagnostics`                          | Wait for a diagnostic event or timeout; no analysis-completion guarantee |
| `get_definition`, `get_references`, `get_hover` | Query installed language providers                                       |
| `preview_rename`, `preview_code_actions`        | Preview provider text edits; no automatic application                    |

Positions are zero-based UTF-16; ranges are end-exclusive. Full URIs are required.
No file creation/deletion/renaming, arbitrary commands, activation or terminal tools.
Search reports truncation/errors: it is not an exhaustive SAP repository index.

See the [tool reference](docs/tools.md) for parameters and limits.

## Further documentation

- [Client setup and optional workflow plugin](docs/clients.md)
- [Development, tests and review rules](docs/development.md)
- [Architecture](docs/design.md) and [security](SECURITY.md)
- [SAP acceptance checks](docs/acceptance.md)
- [Support and issue reporting](SUPPORT.md)
- [Releases and Marketplace setup](docs/releases.md)
