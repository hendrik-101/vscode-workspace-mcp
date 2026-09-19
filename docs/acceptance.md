# SAP ADT acceptance checklist

## Automated coexistence check

`xvfb-run -a npm run test:vscode -- --adt` installs SAPSE.adt-vscode 1.1.2
in an isolated VS Code 1.105.1 profile with no destinations or credentials.
It checks ADT activation and registration of the `abap` filesystem provider,
then runs the bridge's synthetic VFS suite with ADT loaded. CI runs this check.
This does not establish that real ABAP objects can be listed, read or saved.
Microsoft/SAP downloads and third-party network behavior are allowed for setup;
the no-telemetry requirement applies to this project's own runtime code.

## Manual backend and client checks

Run on a disposable development object with an authorized SAP development user.
Never paste private sources, system URLs or tokens into public feedback.

1. Install the VSIX alongside official ABAP Development Tools for VS Code.
2. Start Workspace MCP with no SAP system configured: no crash; absent workspace
   roots are an empty list. This checks coexistence only.
3. Connect ADT on your own device, open a virtual ABAP source and select a method.
4. Connect one client. Verify roots retain the actual scheme/authority and that
   editor_context returns the selected text.
5. Type an unsaved marker manually. read_document must return that marker.
6. Verify a write fails before the VS Code write-approval command.
7. Enable writes; read version, edit a harmless range, inspect the unsaved buffer.
8. Change the document manually, then submit an edit using the old version. It
   must fail and require a new read.
9. Save explicitly. Verify ADT lock/transport prompts and save result. Perform
   activation/checks using the separately configured SAP ADT MCP server only after
   the buffer is saved and system/object identity is verified.
10. Open another VS Code window/system. Verify the client cannot silently cross
    into it. Stop the first server and verify the token no longer works.

Report VS Code/ADT/client versions, operation names and redacted error codes.
Record observed behavior separately for Claude Code, Codex IDE and local desktop.
Native client diff/rewind features are not guaranteed for provider-backed edits.

## IDE provider acceptance

On the work device, verify `show_document` reveals an ADT URI and selection,
without moving focus unless requested. Check `document_symbols` and
`workspace_symbols` against a known class/method; an empty result alone cannot
distinguish unsupported providers from no matches. Preview a proposed change
with `show_diff` and confirm the backend and live buffer remain unchanged.
Preview formatting for an entire source and a selected range, then explicitly
apply with write permission and Auto Save disabled. Check stale versions are
rejected and saving remains a separate action. Synthetic registered providers
exercise these paths in CI but do not establish SAP ADT provider support.
