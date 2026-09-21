# Agent entry point

Keep this MIT project small, readable and telemetry-free.

- Preserve workspace URIs and live buffers. No Node fs/path, `fsPath`, `Uri.file()`,
  shell search or file-scheme filters for workspace operations.
- Admit resources and editor context only within current workspace roots; reject
  traversal and symlink escapes. Require document versions for edits; never
  implicitly save. Writes require user approval and Workspace Trust.
- No shell tools, arbitrary commands or external product requests. The stdio
  adapter may contact only its configured loopback TLS endpoint, with certificate
  pinning and no redirects. Reject hostile Host/Origin and invalid tokens.
- Never commit secrets/customer code, push development to `main`, bypass protection,
  merge without the owner's instruction, or publish without approval.
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
| [Navigation](docs/navigation.md)            | Definitions, references and hover             |
| [Diagnostics](docs/diagnostics.md)          | Waiting semantics and limits                  |
| [Refactoring](docs/refactoring.md)          | Rename/action previews and application limits |
| [Search](docs/search.md)                    | Filters, cursors and consistency              |
| [Initial plan](docs/implementation-plan.md) | Historical delivery scope                     |
