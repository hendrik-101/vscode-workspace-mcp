# Workspace and client acceptance

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

## Manual client checks

Use a disposable workspace and a representative provider-backed document. Keep
private sources, workspace identifiers and tokens out of public reports. Follow
[client setup](clients.md), including Node.js 24+ and Auto Save off.

1. Open a trusted workspace and connect using the generated stdio settings.
2. Open a document, select a range and verify editor context and unsaved reads.
3. Verify write denial, session approval, stale-version refusal and explicit save.
4. Check window isolation, port conflicts and reconnection after Stop and Start.
5. Rotate the token and server identity separately and verify old settings fail.
6. Where applicable, run an authorized non-interactive command and verify new
   output appears only in the explicitly shared channel.

Record the exact extension build, VS Code and client versions, operations, and
redacted errors separately for Claude Code, Codex IDE and local desktop.

## IDE providers

On the work device:

- `show_document`: reveal the document URI/selection without focus change unless requested.
- `document_symbols`/`workspace_symbols`: find a known class/method; empty results
  cannot distinguish absent providers from absent matches.
- `show_diff`: preview without changing backend or live buffer.
- Formatting: preview document/range, explicitly apply with write permission and
  Auto Save off; reject stale versions and keep saving separate.

Synthetic providers exercise these paths in CI; individual provider behavior may differ.

## Direct-command fixtures

The development-host suite loads two independent fixture extensions with their
own manifests and real handlers. It verifies passive discovery without activation,
zero-argument execution with and without a profile, refusal of commands outside
the allowlist, authorization
revocation, cancellation, safe undefined/failure/opaque results, four outstanding
handlers retained across bridge restarts, and bounded reads from an explicitly
shared Output channel. Transport tests verify checked positional arguments and
the Output result contract.
