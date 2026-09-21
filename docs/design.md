# Design

An MIT-licensed VS Code extension exposes one window's workspace and live documents
to MCP clients, including virtual URI schemes. SAP ADT and its MCP server remain
separate products. This independent community project contains no SAP credentials,
private sources or proprietary extension code.

## Components

| Component       | Responsibility                                                             |
| --------------- | -------------------------------------------------------------------------- |
| `workspace.ts`  | VS Code URIs, live buffers, versioned edits and explicit save              |
| `server.ts`     | Official MCP SDK, schemas, request bounds and authenticated loopback HTTPS |
| `tls.ts`        | SecretStorage identity, native WebCrypto and pinned certificate library    |
| `stdio.ts`      | Client adapter; dedicated certificate trust, loopback only, no redirects   |
| `adapter.ts`    | Stable extension-owned adapter installation; no workspace resources        |
| `extension.ts`  | Explicit start/stop, window lifecycle, connection details and write policy |
| Client packages | Shared workflow, thin Claude/Codex manifests and stdio settings            |

No autostart. Writes use user-only `deny`/`allow`/`ask` policy, default `ask`.
Workspace operations use `workspace.fs`, `TextDocument` and `WorkspaceEdit`, never
OS paths. Search requires neither a search provider nor local ripgrep. Saving is
separate from editing and never activates ABAP objects; SAP save hooks may prompt
for locks/transports.

## Security boundary

Listen only on `127.0.0.1`, fixed configurable port (default `39117`). Persist a
random 256-bit token and TLS identity in SecretStorage until explicit rotation.
The adapter pins the certificate before sending credentials, preventing another
local port owner from impersonating the bridge.

Authorize before MCP parsing; validate Host, reject Origin, bound request size
and concurrency, and close completed transports. Recheck current roots and
Workspace Trust; reject traversal and symlinks. Tokens authorize only admitted
roots in the connected window. Installed filesystem providers are trusted VS Code
extensions, outside this boundary.

No telemetry, analytics, external requests, remote listener, shell, terminal,
arbitrary commands, file deletion or backend activation. Only the stdio adapter
initiates product connections, to the authenticated loopback listener.
See [SECURITY.md](../SECURITY.md) for threats and reporting.

## IDE operations

Fixed VS Code APIs provide document display, symbols, diffs, formatting,
[navigation](navigation.md), [diagnostics](diagnostics.md) and
[refactoring previews](refactoring.md). Registered providers determine support;
there is no direct LSP connection or ABAP-specific protocol.

Formatting uses the normal edit validator and mutation path. Symbol locations
are bounded and independently authorized. Proposal diffs use a bounded read-only
in-memory content provider disposed on stop. Cancellation is checked before UI
dispatch; dispatched UI operations and edits cannot be rolled back on disconnect.
[Search](search.md) reports bounds and incomplete results explicitly.

## Verification and delivery

Real extension-host tests use an in-memory non-file FileSystemProvider to cover
unsaved text, write refusal, version conflicts, search, save and containment.
Transport tests use real MCP clients and sockets. See [acceptance](acceptance.md)
for SAP coexistence versus backend/client validation.

CI builds, tests and packages a VSIX without publishing. Initial delivery is an
unmerged PR, not a production-readiness claim. Review, scan and release gates are
in [development rules](development.md).
