# Direct extension commands and Output channels

`search_commands` combines live public VS Code command IDs with IDs from installed
extensions' `contributes.commands` manifests. Discovery never invokes a handler or
activates an extension. Search matches ID, title, category or extension ID by
case-insensitive substring. Results include `registered`, manifest metadata and an
eligibility reason. Use `nextOffset` with the same query, and check `incomplete`.
Discovery scans up to 10,000 runtime IDs, 256 extensions and 5,000 contributions.
Incomplete discovery cannot grant execution eligibility.

## Configure a command

In **Preferences: Open User Settings (JSON)**, add the exact command ID to
`workspaceMcp.allowedCommands` and a matching profile to
`workspaceMcp.commandProfiles`. Both settings default to empty and are read only
from VS Code's user configuration. An agent or repository should never supply
permission through workspace settings. Each profile describes one exact command
ID, extension ID and installed version and confirms that the user has verified
non-interactive behavior for that version.

`argumentTypes` is the ordered list of expected positional argument types. An
empty list means zero arguments. Supported types are `string`, `number`,
`boolean` and `null`, with at most eight arguments and 2,048 UTF-16 code units per
string. Discovery reports these types from the profile. VS Code's ordinary
command manifests supply labels and context menu placement. A shortcut can
supply an argument, but ordinary manifest entries provide no general handler
signature. In particular, passing an ABAP URI as a string does not create a
`vscode.Uri` or an Explorer/TreeView object. Verify argument types and context
for each command before enabling it.

An optional `activeEditorScheme` requires a matching active editor. An optional
`requiresConfiguration` array requires exact matches for up to ten effective
configuration values, for example
`[{ "key": "example.ready", "value": true }]`. Use non-secret flags.
A command needs an unambiguous manifest contribution, a registered ID and a
trusted workspace with at least one root. Duplicate profiles, stale versions,
unmet prerequisites and missing registrations are ineligible. The bridge checks
authorization, profiles and editor context again immediately before dispatch.
Manifest claims cannot prove handler ownership. A profile is a user-reviewed
call description, and installed handlers may have effects beyond workspace roots.

Call `invoke_command({commandId, args, timeoutMs})`. Omit `args` for a
zero-argument profile. Input with the wrong arity or types is rejected before
dispatch. A command with a profile that expects an active editor runs with
the editor already active. Set up that editor before invoking it.

## Return values and shared Output

The default and maximum invocation wait is 20 seconds. The tool returns
`handler_completed` with a value type, `handler_failed`, or
`completion_unconfirmed` after timeout, cancellation or stop. Only type
summaries cross MCP. Raw handler payloads and errors can contain credentials and
are omitted. Handler completion leaves `businessSuccess` unknown. A timed-out
or cancelled wait does not stop a handler. Do not retry ambiguous executions
automatically. Four unfinished handlers can remain across bridge restarts until
they settle or the extension host restarts.

For text written to the VS Code **Output** panel, show the desired channel and
run **Workspace MCP: Share Visible Output Channel**. Select the channel in the
picker. `read_output({maxChars})` reads the tail of that exact channel while VS
Code exposes its text document as visible. The default is 16,000 UTF-16 code
units and the maximum is 64,000. Results include the document version and
whether the snapshot was truncated. The tool reports `not_shared` or
`not_visible` when appropriate. It returns existing history and subsequent
writes to the same channel, with no attribution to an individual invocation.
Share only a channel whose contents may go to connected clients. **Workspace
MCP: Stop Sharing Output Channel** and stopping the bridge both revoke sharing.

## SAP ADT Class Run

SAP documents Class Run from the open ABAP class using **ABAP: Run ABAP
Application (Console)**. VS Code sends no positional arguments when launching
a contributed command from the Command Palette. The following is a profile to
try for that editor-based workflow. Replace `INSTALLED_ADT_VERSION` with the exact
installed version reported by `search_commands`, and first verify the behavior
with your connected SAP destination and a class that implements
`IF_OO_ADT_CLASSRUN`.

```json
{
  "workspaceMcp.allowedCommands": ["adt-vscode.runApplication"],
  "workspaceMcp.commandProfiles": [
    {
      "command": "adt-vscode.runApplication",
      "extensionId": "sapse.adt-vscode",
      "extensionVersion": "INSTALLED_ADT_VERSION",
      "argumentTypes": [],
      "nonInteractive": true,
      "activeEditorScheme": "abap"
    }
  ]
}
```

1. Run Class Run manually once if needed to identify its Output channel. Share
   that channel and leave it visible alongside the ABAP editor.
2. Keep the intended class active and check `search_commands` for eligibility.
3. Call `invoke_command({commandId: "adt-vscode.runApplication"})`, then
   `read_output`. Compare the Output snapshot or its version with a pre-run
   snapshot if the channel already contains output.

SAP backend behavior, exact URI arguments and unattended destination login
require separate verification. This flow assumes an already connected
destination.

[SAP's Class Run instructions](https://developers.sap.com/tutorials/abap-environment-adt-coretools-vscode/)
· [VS Code command arguments](https://code.visualstudio.com/api/extension-guides/command#command-arguments)
· [VS Code Output API](https://code.visualstudio.com/api/references/vscode-api#window.createOutputChannel)
