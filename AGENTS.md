# Agent entry point

Keep this MIT project small, readable and free of telemetry. Preserve full VS Code
URIs and live buffers. No shell tools, arbitrary commands or outbound requests.
Use feature branches and PRs. **Never push development commits to `main`, merge
without the owner's explicit instruction, or publish a release without approval.**

Read the relevant documents before working:

- [Development rules](docs/development.md): **required for every change**; branching,
  validation, Codex reviews, merge authority and release policy.
- [Design](docs/design.md): architecture, scope and security boundary.
- [Security](SECURITY.md): threat model, token handling and reporting.
- [Client integration](docs/clients.md): supported clients and plugin packaging.
- [SAP acceptance](docs/acceptance.md): manual checks and unverified behavior.
- [Initial implementation plan](docs/implementation-plan.md): first-delivery scope.

## Code Review Rules

### Virtual workspace correctness

Workspace resources must remain VS Code URIs. Flag Node fs/path, fsPath,
Uri.file(), local shell search or a file-scheme filter in workspace operations.
Read unsaved buffers; require document versions for edits; never implicitly save.

### Access boundary

Every resource and editor context must be within admitted current workspace roots.
Reject traversal, symlink escapes, hostile Host/Origin and missing/invalid tokens.
Writes need explicit session opt-in and Workspace Trust. No network binding beyond
loopback, no outgoing product requests, no secrets in logs or checked-in files.

### Honest results

Report partial search, save refusal and validation failures as such. Do not claim
SAP backend, cloud-client or Security-scan validation from a synthetic test.
