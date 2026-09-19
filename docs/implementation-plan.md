# Initial bridge implementation plan

Goal: provide a small, safe VFS bridge with installable client configurations.
Architecture and constraints: see [design](design.md), the binding design brief.
Stack: TypeScript, VS Code API, official MCP SDK, Node HTTP, Node test runner.

1. Establish the feature branch, MIT license, repository rules and CI. Main is
   seeded only with GitHub's initial repository metadata; all development uses PRs.
2. Implement WorkspaceService with roots/context/list/read/search/edit/save/
   diagnostics. Verify scheme, authority and root containment, dirty documents,
   stale edits, invalid ranges, bounded search and failed save handling.
3. Implement authenticated loopback transport and schemas. Exercise unauthenticated
   requests, bad tokens, hostile Host/Origin, invalid payloads and an actual MCP
   initialization/tools-call round trip before declaring transport complete.
4. Connect explicit extension commands and session-only write approval. Add thin
   client bundles and document local-host versus hosted ChatGPT deployment.
5. Build a VSIX, run strict checks and tests, review code and dependency audit.
   Request a separate Codex Security scan; record blockers honestly if unavailable.
6. Open a PR, enable repository protection and hosted Codex review where account
   access permits, and provide the exact manual SAP acceptance steps.

Review focus: URI aliases and traversal; provider errors and symlinks; concurrent
human edits; resource exhaustion; tokens accidentally entering logs/config commits.
