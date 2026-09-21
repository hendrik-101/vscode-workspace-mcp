# Initial delivery plan (historical)

Scope: a small VFS bridge and installable client configurations. Stack: TypeScript,
VS Code API, official MCP SDK, Node HTTP and Node test runner.
Current architecture and gates: [design](design.md), [development](development.md).

1. Establish MIT licensing, repository rules, feature branch and CI.
2. Implement roots/context/list/read/search/edit/save/diagnostics. Test URI identity,
   containment, dirty buffers, stale versions, exact ranges, bounds and save refusal.
3. Add authenticated loopback TLS and stdio. Test invalid tokens, Host/Origin and
   payloads, plus a real MCP initialization/tools-call round trip.
4. Add explicit lifecycle commands, write approval and thin client bundles;
   distinguish local from hosted deployment.
5. Build the VSIX; run checks, tests, dependency review and a separate Codex Security
   scan. Record unavailable checks as blockers.
6. Open a PR, configure protection/cloud reviews where account access permits,
   and supply [manual SAP checks](acceptance.md).

Review URI aliases, traversal, symlinks, provider errors, concurrent edits,
resource exhaustion and credential leakage.
