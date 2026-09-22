# Client setup

Install the VSIX, open the intended workspace and run **Workspace MCP: Start**,
then **Workspace MCP: Show Connection Details**. Copy the generated stdio settings
for `workspace_mcp`. The client needs Node.js 24+ and launches the bundled adapter
with `node` using its generated absolute path. Start installs it in VS Code's
extension storage, so the path survives extension upgrades.

The adapter connects only to the local extension over authenticated TLS, trusting
only its supplied public certificate. No endpoint discovery or redirects;
credentials travel in environment variables, never command arguments.

## Adapter upgrades and storage

After upgrading the extension, run Start and restart the client connection to load
the updated adapter. If client settings still point inside a versioned extension
installation, copy connection details once to switch to the stable path;
credentials stay the same.

The path belongs to the current VS Code storage location and extension host.
Changing profiles, user-data directories or hosts may require new connection
details. The client needs access to that file and the host's loopback interface;
a stable path provides no remote access. Unavailable or non-local storage makes
Start fail visibly.

Only the packaged adapter and third-party notices are installed, without downloads
or credentials. Start verifies and reuses the selected copy when both files match
the extension's bundle and the stable launcher is intact. Repeated Starts then add
no copies. Updates, switching back to another version, or concurrent installations
may retain additional copies (about 1.7 MB each), so code another client is loading
remains available. Only committed copies are selected; cancelled preparation stays
unused even if cleanup fails. Historical copies are never automatically pruned.
To reclaim space, stop every bridge and client using this storage, remove only its
`adapter-v1` directory, then Start to recreate the same path.

Windows sharing storage use the most recently published compatible protocol-v1
adapter. Cancelling Start before installation commits preserves the selected
adapter; stopping after commit leaves the completed adapter available. Concurrent
installations select one committed generation deterministically. Starting an older
extension later can select its older compatible adapter; restart the upgraded
bridge to select its bundle again. An incompatible future protocol requires a new
path and updated client settings.

## Connection and write policy

Set these in **User** settings; workspace overrides are ignored:

| Setting                    | Behavior                                                                       |
| -------------------------- | ------------------------------------------------------------------------------ |
| `workspaceMcp.port`        | Default fixed port `39117`, range 1024–65535. Conflicts fail without fallback. |
| `workspaceMcp.writePolicy` | `ask` (default), `allow` or `deny`; Workspace Trust remains required.          |

For simultaneous windows, run **Workspace MCP: Select Port for This Window** in
each window that needs a different port. Enter an unused port explicitly. Accepting
stops that window's bridge; run **Start**, then copy **Show Connection Details** to
a separate private client entry for that window (use distinct names instead of
replacing `workspace_mcp`). The status bar shows the active port; its tooltip and
connection picker show the endpoint. Inspect returned workspace roots before use.

The selection stays in memory across Stop/Start in this window and resets on window
reload. It never changes User or workspace settings and never starts a listener on
its own. Cancel keeps the current connection. The User setting remains the default
for other windows. Ports identify endpoints, not separate credential trust domains.

Token and server identity persist in SecretStorage. Refresh client settings after
port changes or explicit credential/identity rotation. Windows sharing
SecretStorage share credentials: inspect
returned roots before working. Stop closes the connection without deleting the token.
Keep settings private and outside version control; never paste tokens into chats,
issues or plugins.

With `ask`, each start offers **Allow for this session**, **Deny for this session**,
**Always allow** and **Always deny**. Closing the prompt denies writes. Only Always
choices persist `allow`/`deny`. **Enable Writes for This Session** reopens the choices
unless policy is `deny`; change that user setting first.

**Disable Writes for This Session** immediately revokes write permission while
keeping the listener and read access active. It also cancels the authority of a
pending permission prompt, including delayed Always-choice persistence. It does
not change your stored policy: an already-started settings write may still finish,
but cannot re-enable this session. A fresh Enable Writes prompt can grant access
again; Stop/Start applies the User policy anew. Revocation aborts in-flight requests,
but cannot undo edits or saves already handed to VS Code or a filesystem provider.

Turn **Files: Auto Save** off before agent edits; the bridge refuses edits while
it is enabled. Editing and saving remain separate operations.

**Workspace MCP: Rotate Token** stops the bridge before requesting confirmation.
Confirm, restart and refresh client settings; other windows sharing the secret
stop when notified. Cancellation preserves the token and leaves the local bridge
stopped.

## Codex CLI and VS Code extension

Merge generated TOML into `~/.codex/config.toml` without replacing other settings.
`[mcp_servers.workspace_mcp]` uses `command = "node"`, the absolute adapter path in
`args` and these `env` values:

- `WORKSPACE_MCP_URL`
- `WORKSPACE_MCP_TOKEN` (secret)
- `WORKSPACE_MCP_CERTIFICATE` (public)

Copy values verbatim. Configure the client's environment directly; shell exports
may not reach desktop processes. Restart the connection. CLI: `codex mcp list`
shows configuration, `/mcp` shows active connections. IDE: gear menu → MCP servers;
restart the extension after configuration changes.
[Official MCP setup](https://developers.openai.com/codex/mcp).

## Claude Code CLI and VS Code extension

Place generated `mcpServers.workspace_mcp` JSON in private user/local MCP settings:
`type: "stdio"`, `command: "node"`, adapter path in `args` and the same three `env`
values. Never commit tokens in project `.mcp.json`. Reload and inspect `/mcp`.
Copilot's MCP settings configure a separate client.
[Claude MCP setup](https://code.claude.com/docs/en/mcp).

## Desktop and remote hosts

For the desktop app using the same Codex host, use that host's
`~/.codex/config.toml` as above. Open **Settings → MCP servers**, restart the
connection and check `/mcp`.
[Desktop MCP setup](https://developers.openai.com/codex/mcp).

The adapter needs access to its installed file and the extension host's network
environment. SSH, containers, WSL and cloud execution may have different loopback
interfaces. The bridge provides no tunnels or remote listener. Hosted ChatGPT web
cannot read local Codex settings or launch this adapter; hosted integration is
separate work.

## Optional workflow plugin

`plugins/vscode-workspace-mcp` contains a shared skill and thin Codex/Claude
manifests, no credentials, connection files, hooks or server. Pair MCP first;
installing the plugin neither connects nor grants writes.

Claude CLI, from the repository root:

```sh
claude --plugin-dir ./plugins/vscode-workspace-mcp
```

Invoke `/vscode-workspace-mcp:workspace-mcp`.
[Plugin reference](https://code.claude.com/docs/en/plugins-reference).

Alternatively install a persistent personal skill from the repository root:

```sh
mkdir -p ~/.claude/skills/workspace-mcp
cp plugins/vscode-workspace-mcp/skills/workspace-mcp/SKILL.md ~/.claude/skills/workspace-mcp/SKILL.md
```

Start a new session and invoke `/workspace-mcp`. Copy the skill file, not its
enclosing plugin directory.
[Skill locations](https://code.claude.com/docs/en/skills#choose-where-skills-load).

For Codex, add the compatibility manifest to a personal catalog using the
[plugin packaging guide](https://developers.openai.com/plugins/build/plugins).
This repository supplies no catalog or local installation command. Without a
catalog, ask Codex to read `plugins/vscode-workspace-mcp/skills/workspace-mcp/SKILL.md`
and use the paired tools.

Check the connection by listing roots and reading a document with an unsaved
change. Verify SAP/backend behavior separately using [acceptance](acceptance.md).
