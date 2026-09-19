# Security

This is an initial preview, not a certification or a completed SAP backend test.
Do not post credentials, MCP tokens or private source code in public issues.
Use GitHub private vulnerability reporting when enabled, or contact the repository
owner privately before disclosing an exploitable issue.

## Boundary

- Explicit start, loopback-only listener, persistent random SecretStorage token; no autostart.
- User-only write policy: deny, allow or ask (default). Ask starts read-only and
  offers session-only or persistent allow/deny; dismissal denies writes.
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
revokes the session and closes its listener, but retains the stored credential.
Restarting reuses it. Only **Workspace MCP: Rotate Token** replaces it after
confirmation; rotation stops the local bridge even when cancelled or storage fails.
Secret events synchronously suspend requests and writes in other active windows.
A matching stored token resumes access; a changed or unreadable token stops them.
The credential is shared by windows using the same extension SecretStorage,
including windows on different configured ports. Treat those windows as one
credential trust domain; inspect workspace roots before working.

Settings are application-scoped and read from user configuration only, never
checked-in workspace settings. Changing write policy to deny also blocks writes
in a running session. Allow applies at the next start or explicit permission
prompt. Changing the port requires a restart. Port collisions fail without fallback.
First-time concurrent initialization has no atomic SecretStorage compare-and-swap;
readback and change events fail closed, so a competing change may require restart.
Never automatically replace a malformed or inaccessible stored token.
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
