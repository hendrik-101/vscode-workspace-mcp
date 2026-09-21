# Waiting for diagnostics

`get_diagnostics` continues to return the currently stored editor diagnostics.
It does not wait for a language provider.

`wait_for_diagnostics` accepts a complete workspace `uri`, its expected live
`version`, and optional `timeoutMs` (1–20000, default 1000). It observes diagnostic
change events for that exact URI, including changes during document loading.
After loading and checking the document, it waits up to `timeoutMs` for an event
unless one was already observed. It then returns the current bounded diagnostic
snapshot with:

- `outcome`: `event_observed` if a matching event wins the wait, otherwise `timeout`.
  Events arriving during final authorization do not change the settled outcome.
- `documentVersion`: the live document version at capture.
- `capturedAt`: the snapshot capture time as an ISO timestamp.
- `analysisComplete`: always `"unknown"`.

VS Code's public diagnostic API does not expose the analyzed document version,
causal relationship to an edit, provider availability, or analysis completion.
An event may represent clearing diagnostics or unrelated provider activity for
that document. Neither an event nor an empty result establishes a clean build or
completed analysis. The returned document version describes the live buffer,
not a language server's analysis version. No save or activation is performed.

Document changes, closure or replacement produce `VERSION_CONFLICT`. Closure
is observed from the start of authorization, even if the URI was initially unopened.
Workspace roots, symbolic-link admission, Workspace Trust and session state are checked
before returning diagnostics. Cancellation and stopping the bridge release the
listeners and timers. An additional 25-second overall deadline bounds slow
provider authorization/loading, below the server's 30-second request timeout;
exceeding it returns `LIMIT_EXCEEDED`, not a diagnostic snapshot. VS Code provider
calls already in progress cannot be cancelled, but cannot publish a late result
or start further authorization or document-opening calls after cancellation.

At most 16 diagnostic operations may have unfinished provider work in one running
bridge. Cancellation returns promptly and removes listeners and timers, but keeps
that provider slot reserved until the underlying work settles. Additional waits
return `LIMIT_EXCEEDED` before registering listeners or invoking a provider.
