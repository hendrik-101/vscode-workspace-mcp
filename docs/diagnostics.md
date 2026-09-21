# Diagnostics

`get_diagnostics` returns stored diagnostics immediately. `wait_for_diagnostics`
accepts a full workspace `uri`, expected live `version` and optional `timeoutMs`
(1–20000; default 1000).

The wait observes exact-URI diagnostic events from authorization onward, including
loading. After loading/version checks, it waits up to `timeoutMs` unless an event
was already observed. The bounded snapshot contains:

| Field              | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `outcome`          | `event_observed` or `timeout`; frozen before final authorization |
| `documentVersion`  | Live buffer version at capture, not the analyzed version         |
| `capturedAt`       | ISO capture timestamp                                            |
| `analysisComplete` | Always `"unknown"`                                               |

VS Code exposes neither analyzed version, edit causality, provider availability
nor completion. An event can clear diagnostics or reflect unrelated activity for
that URI. Neither an event nor empty diagnostics proves completed analysis or a
clean build. The tool never saves or activates.

Changes, closure or replacement cause `VERSION_CONFLICT`, including closure of
initially unopened documents during authorization. Roots, symlinks, Trust and
session state are rechecked before return. Cancellation/stop releases listeners
and timers. A 25-second overall deadline also bounds authorization/loading and
returns `LIMIT_EXCEEDED`, before the server's 30-second timeout.

Running provider calls cannot be cancelled. After cancellation they cannot publish
results or start further authorization/document opens. Their slots remain occupied
until settlement; a running bridge permits 16 unfinished diagnostic operations.
Excess waits fail with `LIMIT_EXCEEDED` before adding listeners or invoking providers.
