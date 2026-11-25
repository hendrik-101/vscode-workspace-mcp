# Direct extension commands and Output channels

`search_commands` combines live public VS Code command IDs with IDs from installed
extensions' `contributes.commands` manifests. Discovery never invokes a handler or
activates an extension. Search matches ID, title, category or extension ID by
case-insensitive substring. Results include `registered`, manifest metadata and an
eligibility reason. `argumentTypes` describes the call that Workspace MCP
accepts. Without a configured profile, `[]` is the bridge's zero-argument
default. Consult the extension's documentation or verified behavior to
determine the handler signature. Use `nextOffset` with the same query, and
check `incomplete`. Discovery scans up to 10,000 runtime IDs, 256 extensions and 5,000 contributions.
Incomplete discovery cannot grant execution eligibility.

## Allow a command in VS Code

Open **Workspace MCP: Configure Commands** from the Command Palette. You can
also open **Preferences: Open User Settings** and search
`@id:workspaceMcp.allowedCommands`. Under **Workspace MCP: Allowed Commands**,
choose **Add Item** and enter the exact command ID. Use an ID you trust to run
without further input in the current editor. VS Code manifests do not establish
whether the handler opens a dialog or what side effects it can have. On upgrade
from 0.1.2, review existing allowlist entries because an entry can now run
without a profile. To use the default for an existing command, remove its
corresponding profile entry.

For a command without a configured profile, call
`invoke_command({commandId: "example.run"})`. Workspace MCP sends zero
positional arguments. The user allowlist, Workspace Trust, a workspace root,
an unambiguous manifest contribution and a live registration are required.
The bridge checks authorization and context again before dispatch. Manifest
metadata identifies a contribution and cannot prove handler ownership.

## Commands with arguments

Agents should use `search_commands` to find the exact ID, contributing
extension and installed version. Establish the handler's positional arguments
and prerequisites from the extension's documentation or other verified
behavior. VS Code provides no general command-signature API. A shortcut's
fixed `args` or a menu placement describes that invocation only.

For a command that takes arguments, help the user add a profile in **User
Settings (JSON)**. In the graphical Settings editor, search
`@id:workspaceMcp.commandProfiles` and choose **Edit in settings.json**.
VS Code lists this setting in the UI and edits the array of objects in JSON.
Ask the user to apply the entry. Merge into their existing settings arrays
and preserve existing entries. This example assumes a documented command
`example.refreshItem` in extension `example.tools` version `1.2.3` that
accepts an item ID and a boolean.

```json
{
  "workspaceMcp.allowedCommands": ["example.refreshItem"],
  "workspaceMcp.commandProfiles": [
    {
      "command": "example.refreshItem",
      "extensionId": "example.tools",
      "extensionVersion": "1.2.3",
      "argumentTypes": ["string", "boolean"],
      "nonInteractive": true
    }
  ]
}
```

After configuration, check eligibility with `search_commands`, then call
`invoke_command({commandId: "example.refreshItem", args: ["item-42", true]})`.
Supported positional types are `string`, `number`, `boolean` and `null`, with
at most eight arguments and 2,048 UTF-16 code units per string. An empty
`argumentTypes` array describes a zero-argument command with extra
prerequisites. The bridge cannot convert an ABAP URI string to a `vscode.Uri`
or reconstruct an Explorer or TreeView object.

Set `nonInteractive` to `true` only when the reviewed call can complete
without user input. An optional `activeEditorScheme` requires a matching
active editor. An optional `requiresConfiguration` array requires exact
matches for up to ten effective configuration values, for example
`[{ "key": "example.ready", "value": true }]`. Use non-secret flags.
Wrong arity, mismatched types, stale versions, duplicate or mismatched
profiles and unmet prerequisites prevent dispatch. Correct malformed profile
settings before invoking commands. Upgrade a profile after checking the
installed extension version's behavior.

Both settings are read from User settings. Agents can draft settings for
the user and check eligibility after the user applies them.

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
a contributed command from the Command Palette. Add
`adt-vscode.runApplication` to **Workspace MCP: Allowed Commands**. The
default zero-argument call uses the active class. First verify the behavior
with your connected SAP destination and a class that implements
`IF_OO_ADT_CLASSRUN`.

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
