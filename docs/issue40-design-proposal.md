# Issue40 direct commands: scope reconciliation and design proposal

Status: scope confirmed by the parent; implement the live issue's zero-argument
noninteractive subset. Resource contracts remain follow-on work.

## Verified baseline and intent

Fetched `origin/main` on 2026-10-10: `a213717`, containing PR35 (`a213717`)
and PR36 (`12b0b2e`). The isolated working branch is
`feat/issue40-direct-commands`. PR41 belongs to another workstream and must not
be changed, duplicated or merged here.

The intended result is autonomous use of supported human-available VS Code and
extension functions through MCP, with a language-independent core and no UI
automation, interception, private API patching, publishing or access expansion.
Admission must distinguish authorization from capability evidence.

Live [Issue40](https://github.com/hendrik-101/vscode-workspace-mcp/issues/40)
explicitly requires exactly `search_commands` and `invoke_command`, zero
positional arguments, and no resource arguments or LM/MCP bridge. The delegated
newer context raises programmatic resource context and progressive discovery.
The linked ChatGPT conversation returns a login page; Personal Context reports
unavailable. Its contents have not been independently retrieved.

## Essential scope decision

Recommended: deliver the accepted zero-argument subset defined in Issue40.
Keep resource-aware invocation as a follow-on requiring a documented public
contract. This supplies a useful generic admission and invocation mechanism,
but commands without evidence remain discoverable and unsupported.

Alternative: include resource-aware contracts in this delivery. That requires
updating Issue40's explicit exclusions and specifying the resource contract,
argument schema, current workspace admission and non-interactive prerequisites
before implementing. A workspace folder URI does not establish the parameter
contract of an extension-owned TreeView element. Never substitute an active
editor URI or guessed opaque element.

Universal autonomous authentication is unsupported in either approach. SAP's
[documented workflow](https://developers.sap.com/tutorials/abap-environment-adt-coretools-vscode?embed=full)
includes destination selection and browser credentials. The inspected-package
findings preserved in Issue40 are not a tested public headless API. A direct
download of the referenced manifest returned HTTP 403 in this environment;
no fresh SAP bundle inspection or SAP runtime test has been performed here.

## Proposed architecture for the recommended scope

Add a focused command service outside the large document service. Use a small
host interface for unit tests and public `vscode.commands`/`vscode.extensions`
APIs in the runtime adapter. Keep language and extension-specific evidence in
declarations or a reviewed catalog outside production core branches.

`search_commands` obtains IDs from `getCommands(true)`, joins bounded manifest
metadata from `contributes.commands`, and returns paginated filtered entries
with metadata provenance and an eligibility reason. Search never executes or
activates extensions to probe handlers. Title/category/extension identity are
manifest claims, not runtime handler ownership. Duplicate provenance is
ambiguous. Do not evaluate context menus or claim to enumerate applicable
actions for opaque third-party TreeViews.

`invoke_command` takes only a command ID and a bounded wait. Its admission checks
require current trust, bridge session, cancellation, command registration,
explicit exact-version non-interactive capability evidence and separate
user-authorized command scope. Authority must be read only from
`inspect(...).globalValue`; buffer-write permission is insufficient. Unknown,
prompting, stale or ambiguous contracts are denied before dispatch. Re-read
applicable configuration, extension version and declared prerequisites after
asynchronous discovery and immediately before `executeCommand(commandId)`.

The capability evidence format is an implementation design choice, not an
existing VS Code feature. Prefer a reviewed, version-pinned catalog or an
explicit extension-owned declaration, with documented provenance and test
evidence. Do not treat an authorization list or a new setting labelled
"non-interactive" as proof. Existing extensions do not automatically support
a new declaration format. The public API cannot independently prove handler
ownership or sandbox an extension that violates its declaration.

Return handler completion, safe bounded result information, failure or
`completion_unconfirmed`. Use a maximum command wait of 20 seconds, below the
transport's 30-second limit. Hold a process-wide maximum of four dispatched,
unsettled handlers; timeout/disconnect/session stop must not free their slots.
Release only on settlement, including late rejection. Retain the limiter
across bridge restarts to prevent capacity bypass. Do not automatically retry
an ambiguous invocation. Public `executeCommand` has no cancellation token;
canceling the wait does not cancel the command.

Provider results and errors are untrusted. Never echo raw error messages or
serialize arbitrary objects through user-controlled getters or `toJSON`.
Use a bounded safe projection with an explicit redaction/omission indicator;
omit opaque objects and credential-bearing content. A handler returning
`undefined`, or finishing successfully, does not prove business success.

The MCP invocation tool must conservatively declare `readOnlyHint: false`,
`destructiveHint: true`, `openWorldHint: true`, and `idempotentHint: false`.
These hints describe the generic operation, rather than promising properties
the command admission system cannot enforce. Discovery stays read-only.

## Implementation and validation plan

1. Add command types, service and public host adapter with separate admission
   and dispatch. Write regression tests first for non-executing discovery,
   metadata ambiguity, default deny, known prompting commands, invalidation
   during awaits, user-only authority, trust/session stop and canceled dispatch.
2. Integrate the two MCP tools, bounded input/output schemas and accurate
   annotations. Verify tool discovery size, strict argument rejection and
   sanitized transport results/errors; preserve existing document tools.
3. Add two independent fixture extensions, each with its own manifest and real
   extension-host command registrations. Exercise discovery, approved
   zero-argument calls, unapproved prompting handlers, undefined/throw/reject,
   delayed settlement and bounded outstanding capacity. Fixtures prove the
   generic mechanism, not SAP compatibility.
4. Update command contracts, architecture, security boundaries, acceptance and
   the bundled workspace skill consistently. Avoid PR41's review-guidance and
   badge changes. Persist the agreed plan and a draft PR.
5. Run `npm ci`, `npm run check`, `npm run format:check`, `npm test`, native
   integration under Xvfb, `npm run package` and production dependency audit
   sequentially. Perform a separate simplification review. Add packaged native
   validation if the installation fixture wiring changes.
6. Obtain current-head CI, Codex, Security Review and CodeRabbit results, resolve
   consequential threads and formal change requests, verify the authenticated
   merge gate is clean, then squash merge under the user's explicit
   authorization. Re-fetch and verify remote main. No publishing or release.

## Execution decisions

The parent confirmed the recommended scope and authorized continued implementation,
review/fix loops and squash merge after all gates pass. Use GitHub connector
fallback rather than credential restoration. PR41 gets the next CodeRabbit slot.
PR35 evidence confirms Security Review runs alongside Codex review and is also
requestable with `@codex security review`; this remote gate is distinct from local
review. See [implementation plan](issue40-implementation-plan.md).
