# Security

This is an initial preview, not a certification or a completed SAP backend test.
Do not post credentials, MCP tokens or private source code in public issues.
Use GitHub private vulnerability reporting when enabled, or contact the repository
owner privately before disclosing an exploitable issue.

## Boundary

- Explicit start, loopback-only listener, random per-start token; no autostart.
- Read-only until the user enables writes for the current running session.
- Only current workspace roots; no arbitrary URI, terminal or command execution.
- Live document versions required for writes. Saving is separate from editing.
- Edits require Auto Save off. Stop permanently revokes the running session.
- Host/Origin checks, request limits and bounded filesystem traversal.
- No product telemetry, analytics, update checks or outbound network requests.

The client/model provider may receive content returned through MCP. That is the
purpose of the bridge, not telemetry. VS Code and SAP extensions have their own
network behavior and policies. Review those independently. The bridge does not
manage SAP login, transports or activation.

A bearer token grants the configured read/write access to all admitted roots in
one VS Code window. Protect client configuration as a secret. Stopping the bridge
invalidates its token; restarting requires updating the client configuration.
Local processes running as your user, malicious installed extensions and a
dishonest FileSystemProvider are outside this security boundary. Provider stat
metadata is used to reject symbolic links; provider-level path races cannot be
made atomic through the public VS Code filesystem API.

Disconnected or timed-out requests are checked again before applying edits or
saving. An operation already handed to VS Code or the provider cannot be rolled
back by cancellation. Stopping the bridge does not undo existing buffer edits.

The initial version has no remote access or tunnel. For SSH/containers, loopback
is on the extension host; do not expose the listener to a network to work around
client reachability. Hosted ChatGPT web sessions cannot connect directly.

## Reviews

CI tests, dependency auditing, Codex code review and Codex Security are different
checks. Only record a Codex Security scan as completed when its actual report and
scanned revision are available. No automatic merge or Marketplace publishing.
