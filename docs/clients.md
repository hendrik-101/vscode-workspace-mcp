# Connect a client

Install the VSIX, open the intended workspace, then run **Workspace MCP: Start**
and **Workspace MCP: Show Connection Details** from the VS Code Command Palette.
The details contain ready-to-copy client configuration for `workspace_mcp`.
The loopback port is fixed: `workspaceMcp.port` defaults to **39117** (1024–65535).
The bearer token is generated once in VS Code SecretStorage and reused across
restarts and port changes. Set these options in **User** settings; workspace
overrides are ignored. Update client configuration only after changing the port
or explicitly rotating the token. A port already in use fails visibly, without
fallback; stop the other window or choose another user port before starting.
Windows sharing this extension SecretStorage share the credential; inspect the
returned workspace roots before working.

Before enabling agent edits, turn **Files: Auto Save** off for the workspace.
Otherwise VS Code may save an edited buffer automatically even though the bridge
does not call save. Leave Auto Save off when you need to review changes before
the separate save operation.

Keep connection details in private machine configuration, outside version control.
Do not paste tokens into chats, issues, or the optional plugin. Stopping the bridge
revokes its running connection, but does not delete the token.

`workspaceMcp.writePolicy` is `ask` by default: each bridge start offers **Allow for
this session**, **Deny for this session**, **Always allow**, and **Always deny**.
Closing the prompt denies writes. Only the Always choices update the user setting
to `allow` or `deny`; session choices leave it unchanged. Workspace Trust remains
mandatory. **Enable Writes for This Session** reopens the choices unless policy
is `deny`; change that user setting explicitly before allowing writes again.
Editing and saving are separate operations.

**Workspace MCP: Rotate Token** immediately stops the bridge and asks confirmation
before replacing the credential. Afterwards start it and update client settings.
Other active windows sharing the secret stop when notified of the change. Cancelling
rotation leaves the credential unchanged and the local bridge stopped.

## Codex CLI and the native Codex VS Code extension

Merge the generated TOML into `~/.codex/config.toml`, preserving existing settings.
It defines `[mcp_servers.workspace_mcp]`, a `url`, and
`http_headers = { Authorization = "Bearer …" }` with the current token.
The ellipsis here describes the field; copy the actual generated configuration.

Restart the client connection. In the CLI, use `codex mcp list` to inspect configured
servers and `/mcp` in the interactive client to inspect active connections. In the
IDE, open the gear menu, choose MCP servers, then restart the extension after
updating the configuration.

As an alternative to a stored token, Codex supports
`bearer_token_env_var = "VSCODE_WORKSPACE_MCP_TOKEN"`; set that variable in the
client process environment and omit the static Authorization header. A shell
export does not necessarily reach an already running desktop or VS Code process.
[Official MCP configuration](https://developers.openai.com/codex/mcp).

## Native Claude Code VS Code extension and CLI

Use the generated Claude JSON: a `mcpServers.workspace_mcp` entry with
`type: "http"`, the current `url`, and `headers.Authorization`. Configure it in
Claude Code's private user/local MCP settings. A project `.mcp.json` can also hold
the entry, but must not be committed with the token. Reload Claude Code
and inspect `/mcp` before asking it to access the workspace.

For an environment-based credential, Claude accepts
`"Authorization": "Bearer ${VSCODE_WORKSPACE_MCP_TOKEN}"`. The variable must be
available to the Claude Code process. Use Claude Code's own MCP configuration;
VS Code's Copilot MCP settings are a separate client.
[Claude MCP documentation](https://code.claude.com/docs/en/mcp).

## ChatGPT desktop on the same host

The desktop app, Codex CLI, and IDE extension share MCP configuration for the same
Codex host. Use the generated TOML in that host's `~/.codex/config.toml`, including
the Authorization header. In the desktop app, open **Settings → MCP servers**, then
restart the connection. Use `/mcp` to confirm that `workspace_mcp` is connected.
[Official desktop MCP setup](https://developers.openai.com/codex/mcp).

The MCP client must run in the same network environment as the VS Code extension
host. Remote SSH, containers, WSL, and cloud execution can have a different loopback
interface. This initial bridge does not configure tunnels or expose a remote server.
Hosted ChatGPT web sessions do not read local Codex configuration and cannot
directly reach this loopback listener. A hosted integration is separate work.

## Optional shared workflow plugin

`plugins/vscode-workspace-mcp` contains one shared skill and thin Codex/Claude
manifests. Pair the MCP server first. The plugin contains no connection file,
credentials, hooks, or bundled server, and installing it does not establish a
connection or grant write access.

For a Claude Code CLI session, run this from the repository root:

```sh
claude --plugin-dir ./plugins/vscode-workspace-mcp
```

Then invoke `/vscode-workspace-mcp:workspace-mcp`. See the official
[plugin reference](https://code.claude.com/docs/en/plugins-reference) for loading
behavior.

For persistent use as a personal skill without a plugin marketplace, install the
skill itself from the repository root:

```sh
mkdir -p ~/.claude/skills/workspace-mcp
cp plugins/vscode-workspace-mcp/skills/workspace-mcp/SKILL.md ~/.claude/skills/workspace-mcp/SKILL.md
```

Start a new Claude Code session and invoke `/workspace-mcp`. The personal-skill
layout is `~/.claude/skills/<skill-name>/SKILL.md`; do not copy the enclosing
plugin directory there. See the official
[skills documentation](https://code.claude.com/docs/en/skills#choose-where-skills-load).

For Codex, the compatibility manifest is ready for a personal plugin catalog.
This repository does not create that catalog or assume an undocumented local
plugin installation command. To use the workflow immediately without a catalog,
ask Codex to read the repository's
`plugins/vscode-workspace-mcp/skills/workspace-mcp/SKILL.md` and use the already
paired `workspace_mcp` tools. Follow the current
[OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins)
if you want to add it to your personal catalog and install it in the desktop app.

Ask the client to list workspace roots and read one document as a connection
check. Verify that an unsaved editor change appears in the response. Client
configuration and synthetic virtual-workspace tests do not prove SAP backend
compatibility; test that separately against an authorized system.
