# SAP ADT and client acceptance

## Automated coexistence

`xvfb-run -a npm run test:vscode -- --adt` installs SAPSE.adt-vscode 1.1.2 in an
isolated VS Code 1.137.0 profile without destinations/credentials. CI verifies ADT
activation and `abap` filesystem-provider registration, then runs synthetic VFS
tests with ADT loaded. This does not verify real ABAP listing, reading or saving.
Third-party setup/telemetry policy: [development rules](development.md).

## Packaged extension

CI runs unit, VS Code and packaged tests on Linux, Windows and macOS; `verify`
requires every platform. Run `npm run test:vscode -- --packaged` (with
`xvfb-run -a` on headless Linux) to install VSIX archives into a clean profile.
A separate test harness runs in a normal VS Code host so profile secrets persist
across launches. The installed extension starts the bridge; a real stdio client reads roots and
an unsaved buffer, verifies Stop revokes access and reconnects after restart.
A synthetic 0.0.0 predecessor with different adapter bytes upgrades to the
current VSIX, followed by uninstall/reinstall. Saved configuration must work
unchanged and the stable launcher must select the installed payload. This tests
the installer mechanism, not compatibility with a historical released version.

## Manual backend/client checks

Use a disposable object and authorized SAP development user. Keep private sources,
system URLs and tokens out of public feedback. Follow [client setup](clients.md),
including Node.js 24+ and Auto Save off.

1. Install the VSIX alongside official ADT. Start without a configured SAP system:
   no crash, absent roots return an empty list. This proves coexistence only.
2. Connect ADT, open a virtual source and select a method. Connect a client using
   generated stdio settings; no OS certificate installation. Verify root
   scheme/authority and `editor_context` selection.
3. Type an unsaved marker; `read_document` must return it.
4. Under default `ask`, deny the session; writes must fail. Enable writes, read
   the version, edit a harmless range and inspect the unsaved buffer.
5. Change the buffer manually; an edit using the old version must fail and require
   rereading.
6. Save explicitly; verify ADT lock/transport prompts and save result. Use the
   separate SAP ADT MCP server for activation/checks only after saving and verifying
   system/object identity.
7. Open another VS Code window/system. No silent crossover or alternate-port
   fallback; port conflicts must fail. Stop the first bridge: connection closes.
   Restart: saved settings work. Test all four write-prompt choices.
8. Rotate token: old credentials fail and clients require refreshed settings.
   Rotate server identity separately: old trust fails without changing the token;
   refresh configuration and reconnect.

Report VS Code/ADT/client versions, operations and redacted error codes separately
for Claude Code, Codex IDE and local desktop. Native diff/rewind support for
provider-backed edits is not guaranteed.

## IDE providers

On the work device:

- `show_document`: reveal ADT URI/selection without focus change unless requested.
- `document_symbols`/`workspace_symbols`: find a known class/method; empty results
  cannot distinguish absent providers from absent matches.
- `show_diff`: preview without changing backend or live buffer.
- Formatting: preview document/range, explicitly apply with write permission and
  Auto Save off; reject stale versions and keep saving separate.

Synthetic providers exercise these paths in CI, not SAP ADT provider compatibility.
