# Connect a client

Install the VSIX, open the intended workspace, then run **Workspace MCP: Start**
and **Workspace MCP: Show Connection Details** from the VS Code Command Palette.
The details contain ready-to-copy **stdio** client configuration for `workspace_mcp`.
Install Node.js 24 or newer on the client host. The client launches the bundled
adapter with `node`; keep the generated absolute path. Start installs it in VS Code's
extension storage, so the path survives extension upgrades. The adapter
connects only to the local extension over authenticated TLS, using its public
certificate as the sole trust anchor. It never discovers other endpoints or follows
redirects. Credentials are environment values, never command-line arguments.
The loopback port is fixed: `workspaceMcp.port` defaults to **39117** (1024–65535).
The bearer token is generated once in VS Code SecretStorage and reused across
restarts and port changes. Set these options in **User** settings; workspace
overrides are ignored. Update client configuration only after changing the port
or explicitly rotating the token or server identity. After an extension upgrade,
run Start, then restart the client connection to load the updated adapter. If your
existing configuration still points inside a versioned extension installation,
copy connection details once to switch to the stable path; your credentials stay
the same. A port already in use fails visibly, without
fallback; stop the other window or choose another user port before starting.
Windows sharing this extension SecretStorage share the credential; inspect the
returned workspace roots before working.

The stable path belongs to the current VS Code storage location and extension
host. Moving profiles, user-data directories, or remote hosts may require new
connection details. The client needs access to that file and the extension host's
loopback interface; a stable path does not provide remote access. If storage is
unavailable or is not a local filesystem on that host, Start fails visibly.

The extension installs only its packaged adapter and third-party notices, with no
downloads or credentials in these files. Successfully installed adapter generations are retained
so updates cannot remove code that another client is loading. Each Start retains
its own copy (about 1.7 MB), even for the same extension version, so one cancelled
installation can be removed without deleting another window's copy. These copies
are not automatically pruned. To reclaim that space,
stop every bridge and client using this storage, remove only its `adapter-v1`
directory, then Start again. The same path is recreated.

Windows sharing storage use the most recently published compatible protocol-v1
adapter. A rename already in progress when Stop runs can become briefly visible;
after it settles, a cancelled installation removes only its own generation.
Simultaneous publications select one complete generation deterministically;
starting an older extension later can select its older compatible adapter. Restart
the upgraded extension's bridge to select its bundle again. A future incompatible
adapter protocol will need a new path and updated client configuration.

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
It defines `[mcp_servers.workspace_mcp]` with `command = "node"`, an absolute
adapter path in `args`, and an `env` table containing `WORKSPACE_MCP_URL`,
`WORKSPACE_MCP_TOKEN` and `WORKSPACE_MCP_CERTIFICATE`. Copy the generated values
verbatim; the certificate is public, but the token is secret.

Restart the client connection. In the CLI, use `codex mcp list` to inspect configured
servers and `/mcp` in the interactive client to inspect active connections. In the
IDE, open the gear menu, choose MCP servers, then restart the extension after
updating the configuration.

The adapter reads these values from its environment. Configure them privately in
the client; a shell export does not necessarily reach a running desktop process.
[Official MCP configuration](https://developers.openai.com/codex/mcp).

## Native Claude Code VS Code extension and CLI

Use the generated Claude JSON: a `mcpServers.workspace_mcp` entry with
`type: "stdio"`, `command: "node"`, the adapter path in `args`, and the three
connection environment variables in `env`. Configure it in Claude Code's private
user/local MCP settings. Do not commit a project `.mcp.json` containing the token.
Reload Claude Code and inspect `/mcp` before accessing the workspace. VS Code's
Copilot MCP settings are a separate client configuration.
[Claude MCP documentation](https://code.claude.com/docs/en/mcp).

## ChatGPT desktop on the same host

The desktop app, Codex CLI, and IDE extension share MCP configuration for the same
Codex host. Use the generated TOML in that host's `~/.codex/config.toml`, including
the adapter environment values. In the desktop app, open **Settings → MCP servers**, then
restart the connection. Use `/mcp` to confirm that `workspace_mcp` is connected.
[Official desktop MCP setup](https://developers.openai.com/codex/mcp).

The adapter must run in the same network environment as the VS Code extension
host and have access to its installed adapter file. Remote SSH, containers, WSL, and cloud execution can have a different loopback
interface. This initial bridge does not configure tunnels or expose a remote server.
Hosted ChatGPT web sessions do not read local Codex configuration and cannot
launch this local stdio adapter. A hosted integration is separate work.

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
