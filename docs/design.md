# Workspace MCP: initial design

Build a small MIT-licensed VS Code extension that exposes the current window's
workspace and live documents to any MCP client, including non-file URI schemes.
SAP's ADT extension and ADT MCP server remain separate, installed products.
No SAP backend credentials, source code or proprietary SAP extension code belong
in this repository. This is an independent community project, not an SAP product.

## Boundaries

- `workspace.ts`: VS Code APIs and document semantics. Preserve full URI identity;
  never convert workspace URIs into OS paths. Read live buffers, apply versioned
  edits, and save only through a separate operation.
- `server.ts`: the official MCP TypeScript SDK, input schemas, bounded requests,
  internal loopback HTTPS, bearer token and rejection of browser Origins.
- `tls.ts`: persistent server identity in SecretStorage, generated through native
  WebCrypto and pinned certificate library; explicit replacement only.
- `stdio.ts`: MCP stdio adapter with dedicated TLS certificate trust, loopback-only
  destination, no redirects and no external requests. Native clients use stdio.
- `extension.ts`: explicit start/stop, per-window lifecycle and connection details.
  Writes follow a user-only deny/allow/ask policy (default ask); no autostart.
- Client packages: common workflows with thin Claude Code and Codex manifests;
  stdio MCP settings for Codex IDE and ChatGPT desktop on the same host.

Tools: roots, editor context, directory listing, text reading, literal text search,
versioned text edits, explicit save and diagnostics. No shell, terminal, arbitrary
VS Code commands, file deletion, backend activation or remote listener in v0.1.

## Security contract

Bind only to 127.0.0.1 on the configured fixed port (default 39117). Store a
256-bit random bearer token and TLS server identity in VS Code SecretStorage, reused
until explicit rotation. The adapter pins the supplied certificate before sending
credentials. Another local user taking the port cannot impersonate the bridge. Authorize every request before MCP parsing, validate Host,
reject Origin, cap request size/concurrency and close transports on completion.
The token grants access to this window's admitted workspace roots only. Recheck
roots and Workspace Trust for operations. Reject traversal and symlinks. A hostile
filesystem provider is outside the boundary: installed VS Code extensions already
run with user privileges. No telemetry, analytics or external network requests in product code. Only the
stdio adapter may connect to the loopback listener, with verified server identity.

Search is bounded and reports incomplete results. No assumptions about a search
provider or local ripgrep. File operations use workspace.fs / TextDocument /
WorkspaceEdit. Writes never silently save or activate ABAP objects. SAP save hooks
may still prompt for locks/transports; users must verify this on their own backend.

## Verification and delivery

Use an in-memory FileSystemProvider with a non-file scheme in a real VS Code
extension host. Cover live unsaved text, write refusal, version conflicts, search,
save and root containment. HTTP tests use real MCP clients and sockets. SAP ADT
installation without a backend can verify coexistence only, not backend behavior.

The first delivery is an unmerged PR and installable VSIX. Marketplace publication
and a production-ready claim are explicitly out of scope. GitHub-hosted CI builds,
tests and packages without publishing. Cloud Codex reviews and Codex Security
scans are separate checks, never represented as passed without an actual result.
