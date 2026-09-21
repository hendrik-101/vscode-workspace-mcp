# Client setup

Install the VSIX, open the intended workspace and run **Workspace MCP: Start**,
then **Workspace MCP: Show Connection Details**. Copy the generated stdio settings
for `workspace_mcp`. The client needs Node.js 24+ and launches the bundled
`dist/stdio.cjs` using its generated absolute path.

The adapter connects only to the local extension over authenticated TLS, trusting
only its supplied public certificate. No endpoint discovery or redirects;
credentials travel in environment variables, never command arguments.

## Connection and write policy

Set these in **User** settings; workspace overrides are ignored:

| Setting                    | Behavior                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `workspaceMcp.port`        | Fixed port, default `39117`, range 1024–65535. A conflict fails; stop the other window or choose another port. |
| `workspaceMcp.writePolicy` | `ask` (default), `allow` or `deny`; Workspace Trust remains required.                                          |

Token and server identity persist in SecretStorage. Refresh client settings after
port changes, explicit credential/identity rotation or extension upgrades that
change the adapter path. Windows sharing SecretStorage share credentials: inspect
returned roots before working. Stop closes the connection without deleting the token.
Keep settings private and outside version control; never paste tokens into chats,
issues or plugins.

With `ask`, each start offers **Allow for this session**, **Deny for this session**,
**Always allow** and **Always deny**. Closing the prompt denies writes. Only Always
choices persist `allow`/`deny`. **Enable Writes for This Session** reopens the choices
unless policy is `deny`; change that user setting first.

Turn **Files: Auto Save** off before agent edits. Editing and saving are separate
bridge operations, but VS Code Auto Save could otherwise persist buffer changes.

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
