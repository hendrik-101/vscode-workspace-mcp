# Agent entry point

Keep this MIT project small, readable and telemetry-free.

- Preserve workspace URIs and live buffers. No Node fs/path, `fsPath`, `Uri.file()`,
  shell search or file-scheme filters for workspace operations.
- Admit resources and editor context only within current workspace roots; reject
  traversal and symlink escapes. Require document versions for edits; never
  implicitly save. Writes require user approval and Workspace Trust.
- No shell tools, arbitrary commands or external product requests. Bind listeners
  only to loopback. The stdio adapter may contact only its configured loopback TLS endpoint, with certificate
  pinning and no redirects. Reject hostile Host/Origin and invalid tokens.
- Never log or commit secrets/customer code. Never push development to `main`,
  bypass protection, merge without the owner's instruction, or publish without approval.
- Report incomplete results and failed operations honestly. Synthetic tests do
  not prove SAP/backend or native-client compatibility; PR reviews are not Security scans.

Read [development rules](docs/development.md) for every change, including the
current-head review and actual merge-gate checklist before handoff.

| Document                                    | Purpose                                       |
| ------------------------------------------- | --------------------------------------------- |
| [Design](docs/design.md)                    | Architecture and runtime boundaries           |
| [Security](SECURITY.md)                     | Threat model, credentials and reporting       |
| [Clients](docs/clients.md)                  | Connection and optional plugin setup          |
| [Acceptance](docs/acceptance.md)            | Automated scope and manual SAP/client checks  |
| [Tools](docs/tools.md)                      | Display, symbols, diffs and formatting        |
| [Navigation](docs/navigation.md)            | Definitions, references and hover             |
| [Diagnostics](docs/diagnostics.md)          | Waiting semantics and limits                  |
| [Refactoring](docs/refactoring.md)          | Rename/action previews and application limits |
| [Search](docs/search.md)                    | Filters, cursors and consistency              |
| [Initial plan](docs/implementation-plan.md) | Historical delivery scope                     |

## Code Review Rules

Review the diff and trace affected callers, contracts and cleanup paths. Prioritize
observable correctness, security and resource failures. For each finding, identify
the changed line, a reachable input or event sequence, the violated contract and
the user impact. Check existing guards and tests before reporting; distinguish
demonstrated failures from assumptions. Do not inflate severity to obtain a comment.
Leave formatting to CI; avoid style preferences and speculative rewrites.

### Workspace and security boundaries

- Preserve full virtual-workspace URIs and live buffers. Check scheme, authority,
  root membership and provider symlink metadata for both requested and returned
  targets, including navigation, previews and continuations. OS-path conversion
  or file-only assumptions can bypass admission or break SAP workspaces.
- Trace writes through approval, Workspace Trust, Auto Save and document-version
  checks to the actual edit/save call. Recheck after asynchronous work; stop,
  revocation, token changes and stale prompts must not restore old permissions.
  Edits must remain unsaved unless a separate save was explicitly requested.
- Keep loopback TLS, certificate/hostname verification, no redirects, Host/Origin
  checks and authentication intact. Errors and logs must not disclose credentials
  or provider/customer content. Evaluate attacks within [SECURITY.md](SECURITY.md):
  malicious installed extensions and dishonest providers are outside the boundary;
  provider path races cannot be made atomic with public VS Code APIs.

### Concurrency, cancellation and resource ownership

- Trace timeout, abort, disconnect, stop and provider rejection through every
  affected await and side effect. A late result must not authorize a new edit or
  revive a stopped session. Cancellation cannot undo an operation already handed
  to VS Code or a provider; do not report that documented limitation as a new bug.
- Check timers, listeners, observers, sockets, request reservations, cursors and
  snapshots for bounded lifetime and cleanup on success, failure and cancellation.
  Look for double settlement, leaked capacity and cross-window/token/identity races;
  describe the specific interleaving that breaks the invariant.
- Follow limits through input admission, provider traversal, retained state,
  serialization and output. Check bytes versus UTF-16 units, aggregate budgets and
  continuation expiry/invalidation. A per-page cap alone does not bound a session.
  Late provider results must not trigger additional bridge side effects after
  cancellation.

### Protocol contracts, tests and maintainability

- Compare MCP input/output schemas, structured and text content, error codes,
  annotations and documentation with actual behavior. Preserve zero-based UTF-16
  positions, end-exclusive ranges, versions and honest truncation/consistency
  metadata. Keep preview-only refactorings distinct from supported application;
  diagnostic events do not prove analysis completion.
- For changed boundary behavior, look for a regression test exercising the real
  path with a meaningful assertion: stale versions, concurrent changes, revoked
  writes, late/rejected provider results, timeout or limit boundaries as relevant.
  Explain the uncovered failure; missing tests alone do not establish a defect.
  Mocks do not prove SAP/backend or native-client compatibility.
- Review simplifications separately: remove duplication or clarify ownership only
  when it reduces a concrete risk without weakening guards, error reporting or
  public contracts. Do not demand broad refactors or dependencies for stylistic
  consistency. Keep release credentials isolated from untrusted build execution.
