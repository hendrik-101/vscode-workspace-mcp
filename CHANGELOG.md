# Changelog

## 0.1.3 — command settings and Marketplace preview

- Run contributed commands without a profile using the explicit
  `allowedZeroArgumentCommands` User setting. Existing command permissions
  continue to require matching profiles.
- Open VS Code command settings from the Command Palette, and document how
  an agent can help prepare settings for commands with arguments.
- Prepare Marketplace publication through Trusted Publishing, using the same
  tested VSIX as the GitHub release.
- Refresh transitive HTTP dependencies for upstream security fixes.
- Tie document versions to the live buffer and limit the number of editor tabs
  that bridge requests can open.

## 0.1.2 — command and Output preview

- Discover contributed commands before extension activation and show their
  installed versions and runtime registration status.
- Run separately authorized commands using versioned user profiles with
  optional editor prerequisites and typed positional arguments.
- Read bounded snapshots of an explicitly shared visible Output channel.
- Opt in to automatic startup in trusted workspace windows using the existing
  User write policy.

## 0.1.1 — dependency security preview

- Update MCP SDK to 1.32.1, Undici to 7.30.1 and Zod to 4.6.6, and refresh
  compatible transitive dependencies to resolve the current production audit.
- Update pinned GitHub Actions and development tools while preserving Node.js 24
  and the minimum supported VS Code 1.137.0 API types.
- Supersede the unpublished 0.1.0 candidate. Its existing annotated tag remains
  unchanged; no GitHub or Marketplace publication of that version is claimed.
- Native-client acceptance and a Codex Security repository scan remain
  pending for this revision. The owner exceptions recorded for 0.1.0 do not apply
  to this patch release.

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
- Larger bounded formatting/refactoring previews (10,000 edits): formatting allows
  8 MiB cumulative replacement text; the 8 MiB cumulative refactoring budget includes
  both replacement text and target URI bytes. Diagnostic inspection covers 5,000 entries,
  with cumulative resource budgets.
  Full previews may require a larger client receive buffer.
- Workspace Trust, Auto Save protection and session or persistent write policies.
- Authenticated loopback TLS, certificate pinning, token/identity rotation and a
  bundled stdio adapter whose configured path survives extension upgrades.
- Typed tool responses and concise discovery guidance for Codex and Claude Code.
- Synthetic VS Code/provider tests; native-client acceptance remains a separate release gate.
- Registered publisher ID `hendrik101`; owner-created annotated tags publish
  versioned GitHub releases and the same tested VSIX to Marketplace after full CI.
- Preview/stable channels, acceptance/Security evidence, SHA256 and release notes;
  Entra workload federation or explicitly selected PAT authentication. The manual
  draft preview workflow remains available.
- Update MCP SDK to 1.31.0 to resolve the production dependency audit advisory.
- File/folder creation, external login and backend activation are not included.
- MIT licensed, without telemetry, shell tools or arbitrary command execution.
