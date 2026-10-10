# Direct extension commands

`search_commands` discovers runtime IDs through `vscode.commands.getCommands(true)`.
It never executes handlers or activates extensions to probe them. Query matches
ID, title, category or extension ID using a case-insensitive literal substring.
Pages default to 20 entries, maximum 100. Pass `nextOffset` with the same query;
results are live, so changes can move entries between pages. Inspect `incomplete`
and `truncated`; scanning is capped at 10,000 IDs, 256 extensions and 5,000
manifest contributions. Incomplete discovery cannot grant eligibility.

Metadata is untrusted `contributes.commands` content, labelled
`provenance: extension_manifest`. It does not prove runtime handler ownership.
Duplicate manifest claimants are ambiguous and ineligible. Titles/categories may
be unavailable, localized values or truncated to 160 characters.

## Authorization and capability evidence

By default no commands are authorized. The application-scoped user setting
`workspaceMcp.allowedCommands` accepts up to 100 exact IDs. The bridge reads only
`inspect(...).globalValue`; workspace/folder settings cannot grant authority.
Buffer-write policy neither grants nor revokes command authority. Within an
explicitly authorized eligible scope, calls need no per-command human approval.
Do not change settings to bypass a refusal.

Authorization is not evidence of non-interactive behavior. An installed extension
must also contribute the command and explicitly declare the following opt-in
contract in its `package.json`:

```json
{
  "workspaceMcpCommandContracts": [
    {
      "command": "example.refreshWithoutInput",
      "extensionVersion": "1.0.0",
      "arguments": "none",
      "interaction": "none",
      "context": "workspace",
      "documentation": "https://example.org/documented-command-contract",
      "requiresConfiguration": [{ "key": "example.ready", "value": true }]
    }
  ]
}
```

This is a Workspace MCP contract format, not a standard VS Code contribution or
an automatically inferred schema. Extension authors must document and verify
zero-argument, non-interactive behavior for the exact declared version, including
all prerequisites. The documentation URL is evidence provenance, never fetched
or followed by the bridge. Existing extensions without declarations stay
searchable and unsupported. No production extension IDs are hard-coded.

The declaration version must equal the installed extension version. Each command
has exactly one declaration. Configuration prerequisites are optional; each key
is a VS Code configuration key and each expected value a scalar string (maximum
256 characters), finite number, boolean or null. All must match current effective
configuration. Use non-secret prerequisite flags, not credential values. There
are at most 100 declarations per extension and 10 prerequisites per command.
Malformed declarations fail closed.

A supported workspace contract also requires a current workspace root and trust.
The bridge fingerprints roots, current editor/selection/version, configuration
and extension changes around asynchronous discovery and immediately before
execution. Changed admission context denies dispatch; search again. Declaration
and configuration are re-read on each call. Unknown, prompting, stale, ambiguous
or unmet contracts are denied before dispatch.

A manifest claim cannot independently establish runtime handler ownership. The
extension declaration is trusted capability evidence, and installed extension
code lies outside the bridge's security boundary. This admission policy is not
a sandbox: public VS Code APIs cannot universally prevent a dialog or external
side effect if a declared command violates its contract.

## Invocation and results

`invoke_command` accepts `commandId` and optional `timeoutMs` (1–20,000,
default 20,000). It invokes `vscode.commands.executeCommand(commandId)` with no
positional arguments. No resource arguments, UI automation/interception,
Command Palette control, schema guessing or Language Model/MCP proxy is included.
The generic tool declares potentially destructive, external, non-idempotent
side effects. A permitted command may act beyond document-write permissions and
workspace resource boundaries, according to its own extension contract.

The result distinguishes:

- `handler_completed`: the handler settled successfully, with `resultType`.
  Undefined has no payload. All other payloads, including numeric PINs,
  booleans, null, text, objects and nonJSON content, are omitted
  (`resultOmitted: true`). No getters, keys or `toJSON` are inspected.
- `handler_failed`: synchronous throw or rejected promise; raw error details are
  suppressed to avoid disclosing extension credentials or source content.
- `completion_unconfirmed`: timeout, canceled wait or stopped session. The
  handler may still run. No operation-status or continuation tool is provided.

Every outcome has `businessSuccess: unknown`. Handler completion or undefined
does not independently establish business success. Only type summaries cross MCP; the generic tool does not return arbitrary
handler payloads or raw errors.

The 20-second wait is below the transport's 30-second deadline. At most four
unfinished handlers are admitted across bridge restarts in one extension host.
Timeout, cancellation and disconnect do not free that capacity; only settlement
does. A permanently pending handler retains a slot until the extension host
restarts. VS Code exposes no command cancellation token. Never automatically
retry an ambiguous execution; cancellation does not undo side effects. As with
other extension APIs, synchronous code blocking the extension host cannot be
preempted by a JavaScript timer.

## ADT limitation and follow-on scope

This feature does not deliver autonomous **Log On to Destination**. SAP's
[documented workflow](https://developers.sap.com/tutorials/abap-environment-adt-coretools-vscode?embed=full)
can require browser credentials. The package inspection recorded in
[Issue40](https://github.com/hendrik-101/vscode-workspace-mcp/issues/40) found that
an `abap:` URI can bypass initial destination selection, but did not establish a
public stable headless authentication contract. No declaration for SAP login is
provided here, so it remains unsupported.

Resource-aware commands are follow-on work requiring explicit public argument and
non-interactive contracts. An Explorer resource URI is different from an opaque
third-party TreeView element; neither an active editor URI nor manifest menu
metadata proves the required context. Progressive discovery is possible only
where a real supported programmatic contract exposes the next required data.
Synthetic fixture extensions prove this bridge mechanism, not SAP compatibility.
