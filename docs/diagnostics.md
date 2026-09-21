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

## Bounded snapshot contract

Both tools accept `maxResults` (default 20, 1–100), optional `severity`
(`error`, `warning`, `information`, or `hint`), and optional continuation
`offset` plus `snapshotId`. The first page uses offset 0 and no snapshot ID.
A snapshot ID requires a positive offset, and a positive offset requires a
snapshot ID; incomplete pairs are rejected before provider work.
Continue with the returned `nextOffset` and `snapshotId`, the same URI, severity
and page size. Prefer `get_diagnostics` for continuation after a wait: another
wait still performs its usual version checks and event/timeout observation.

`counts` reports each severity across the first 1000 stored diagnostics, before
filtering or pagination. `inspected` is that bounded count, `total` is the stored
array length, and `incomplete` says entries beyond the inspection bound were not
examined. `matching` counts filter matches in the inspected source only. Provider
order is preserved; offsets index the filtered inspected source. An empty page
means no remaining matching entries in that source, never completed analysis.

`snapshotId` fingerprints the complete exposed fields (before text clipping) of
all inspected entries and the total length, URI, severity, page size, current
workspace roots, live document version when open, and bridge session. Continuation
recomputes it after authorization. Changed data or bindings fail with
`DIAGNOSTICS_CHANGED`; malformed/missing continuation arguments fail with
`INVALID_ARGUMENT`. Restart at offset 0 after a conflict. No snapshot data is
cached. Equal fingerprints prove equality of this bounded observation, not that
no intervening event occurred, that entries beyond 1000 stayed equal, or that a
language provider analyzed the current buffer.

Each result is bounded to 16000 serialized JSON characters (excluding MCP wrapper
and duplicated text/structured representations). URI JSON is limited to 8192
characters. Messages are at most 4096 characters and optional source/string code
at most 256; each clipped field carries its corresponding `messageTruncated`,
`sourceTruncated`, or `codeTruncated` marker. A first message can be shortened
further to guarantee page progress within the budget. `truncated` is true when
more matching entries remain, the inspection is incomplete, or returned text was
clipped. `nextOffset` appears only when another inspected match remains. Text
clipping and entries past the inspection bound cannot be recovered by pagination.

Implementation sequence:

1. Add regression cases for bounded output/progress, complete inspected counts,
   filtering, continuation binding and changed diagnostics, and wait metadata.
2. Extend the shared input/result contracts and both strict tool schemas.
3. Implement a single bounded snapshot formatter while retaining authorization,
   version checking, cancellation, event timing and provider admission unchanged.
4. Run targeted and full tests, type/format checks, VS Code integration, packaging
   and dependency audit; review the implementation separately for simplification.
