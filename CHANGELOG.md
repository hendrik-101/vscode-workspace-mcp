# Changelog

## 0.1.0 — initial preview

- Scheme-preserving workspace roots, paginated directories and live-buffer reads
  with exact ranges, byte limits and versioned continuation.
- Filtered literal search with bounded responses and resumable cursors.
- Scoped editor context; bounded, filtered diagnostic pages and diagnostic waits.
- Precise document/workspace symbol outlines and version-checked symbol-body reads.
- Provider definitions, references and hover; document reveal and diff previews.
- Formatting, rename and code-action previews; version-checked text edits and
  separate saves. Applied formatting responses stay compact.
- Direct-command discovery and zero-argument invocation, requiring separate
  user authorization and an exact-version, non-interactive extension contract.
  Handler payloads are omitted; completion does not establish business success.
- Larger bounded formatting/refactoring previews (10,000 edits, 8 MiB replacement
  text) and diagnostic inspection (5,000 entries), with cumulative resource budgets.
  Full previews may require a larger client receive buffer.
- Workspace Trust, Auto Save protection and session or persistent write policies.
- Authenticated loopback TLS, certificate pinning, token/identity rotation and a
  bundled stdio adapter whose configured path survives extension upgrades.
- Typed tool responses and concise discovery guidance for Codex and Claude Code.
- Synthetic VS Code/provider tests and SAP ADT coexistence checks; real SAP and
  native-client acceptance remain separate release gates.
- Registered publisher ID `hendrik101`; owner-created annotated tags publish
  versioned GitHub releases and the same tested VSIX to Marketplace after full CI.
- Preview/stable channels, acceptance/Security evidence, SHA256 and release notes;
  Entra workload federation or explicitly selected PAT authentication. The manual
  draft preview workflow remains available.
- Update MCP SDK to 1.31.0 to resolve the production dependency audit advisory.
- Generic workspace APIs remain independent of SAP ADT. File/folder creation,
  ABAP object creation, autonomous ADT login and backend activation are not included.
- MIT licensed, without telemetry, shell tools or arbitrary command execution.
