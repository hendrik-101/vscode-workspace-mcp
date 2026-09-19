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
4. Connect one client through the generated stdio configuration (Node.js 22+).
   No OS certificate installation is needed. Verify roots retain the actual scheme/authority and that
   editor_context returns the selected text.
5. Type an unsaved marker manually. read_document must return that marker.
6. Use the default `ask` policy and deny this session; verify a write fails.
7. Enable writes; read version, edit a harmless range, inspect the unsaved buffer.
8. Change the document manually, then submit an edit using the old version. It
   must fail and require a new read.
9. Save explicitly. Verify ADT lock/transport prompts and save result. Perform
   activation/checks using the separately configured SAP ADT MCP server only after
   the buffer is saved and system/object identity is verified.
10. Open another VS Code window/system. Verify the client cannot silently cross
    into it. The same port must fail explicitly, never silently choose another.
    Stop the first server and verify the connection closes. Restart and verify the
    saved client settings still work; explicit token rotation must reject the old
    token and require new client settings. Test all four write-prompt choices.
11. Rotate server identity independently and verify old client trust fails without
    changing the bearer token. Refresh client configuration and reconnect.

Report VS Code/ADT/client versions, operation names and redacted error codes.
Record observed behavior separately for Claude Code, Codex IDE and local desktop.
Native client diff/rewind features are not guaranteed for provider-backed edits.
