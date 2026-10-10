# Issue40 direct commands implementation plan

Scope confirmed by parent: implement the live issue's zero-argument,
noninteractive subset; resource contracts remain follow-on work. Execution is
native, with an independent final simplification/security review. No publishing.

## Design decisions

- A focused host-independent `CommandService` uses a public VS Code adapter.
- Installed extensions may explicitly declare `workspaceMcpCommandContracts`
  in their manifests. The format pins extension version, command ID,
  `arguments: none`, `interaction: none`, `context: workspace`, and a
  documentation URL. Optional scalar configuration prerequisites must match.
  This is an opt-in contract format, not a standard VS Code contribution.
- A separate application-scoped `workspaceMcp.allowedCommands` user setting
  supplies authorization only. Default is empty. Workspace overrides cannot
  grant permission. No buffer-write permission is reused.
- Runtime command IDs plus contributed metadata are discovery only. Ambiguous,
  missing, stale, undeclared, or unmet contracts are denied. Manifest identity
  cannot prove runtime ownership; extension declarations are trusted evidence,
  not a sandbox. Existing extensions need a real declaration to become eligible.
- Re-read command registration and snapshot trust/session/configuration/extension
  version/workspace/editor context around awaits before dispatch. No UI calls,
  resource arguments, probing, extension activation or automatic retries.
- Hold at most four unfinished commands process-wide across service restarts.
  Wait at most 20 seconds, returning completion_unconfirmed before the 30-second
  transport timeout. Canceled waits cannot cancel handlers or free their slots.
- Suppress arbitrary result payloads and errors. Return a bounded type summary
  only. All raw payloads, including numeric/boolean/null scalars, text, objects,
  arrays, functions, bigints and symbols are omitted to avoid leaking credentials or
  invoking getters/toJSON. Handler completion is not business success.

## Tasks

- [x] Write service regressions and observe failure before implementation.
- [x] Implement declaration validation, discovery, admission and bounded dispatch.
- [x] Add public VS Code adapter and two MCP tools with strict schemas and accurate
      annotations; test transport behavior and tool discovery budget.
- [x] Add two separate real extension-host fixture extensions and regression suite.
- [x] Update security/architecture/tool/acceptance/plugin guidance without PR41's
      review-guidance or badge changes.
- [x] Run check, format, unit tests, native tests, package and audit sequentially.
- [x] Run independent simplification/security review and fix findings.
- [ ] Deliver a draft PR through GitHub connector. Verify current-head CI, Codex,
      Security Review, CodeRabbit, threads, formal reviews and clean mergeability.
- [ ] Squash merge under existing authorization and verify fetched remote main.

## Review focus

- A manifest claiming a command is not proof of handler ownership.
- Capability changes while getCommands is awaiting must deny dispatch.
- Unsettled handlers survive timeout, cancellation and bridge restart capacity.
- Output with getters, cyclic references and secrets must never be inspected.
- Prompting/unknown commands must be refused without executing their handlers.

## Delivery constraints

Workspace GH_TOKEN is invalid; use the GitHub connector rather than restoring
or transmitting tokens. PR41 gets the next free CodeRabbit slot. Request this
branch's CodeRabbit review only after implementation is ready and coordinated.
A local security review does not substitute for required remote Security Review.

## Local validation evidence

On 2026-10-10: TypeScript and formatting passed; 420 unit tests passed; the
real VS Code 1.137 extension-host suite passed with both independent fixture
extensions; VSIX packaging and packaged-extension smoke tests passed; the 22-tool discovery
response measured 62,768 bytes against the unchanged 64,000-byte budget. The
production dependency audit found zero
vulnerabilities. The independent code review identified unsafe proxy inspection
and failed-listener subscription cleanup; both were reproduced and fixed with
regressions. Its second pass reported no consequential findings. This independent
review is not the required remote Codex Security Review. Remote gate evidence
will be recorded on the PR, tied to its current head.
