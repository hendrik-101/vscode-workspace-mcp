# Workspace search

`search_workspace` finds single-line literal text in live documents, including
unsaved buffers and virtual URIs. Starting URI and traversal stay within current
workspace roots; traversal paths and symlinks are rejected. Inputs: `uri`,
`query` (1–4,096 UTF-16 code units), optional `maxResults` (integer 1–100, default 20), plus:

| Input                | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `include`, `exclude` | Up to 20 filename globs each, 256 characters per glob; exclusion wins |
| `caseSensitive`      | Default `true`; `false` uses Unicode-aware literal matching           |
| `wholeWord`          | Default `false`; boundaries use ASCII letters, digits and underscore  |
| `contextLines`       | 0–5 lines per side, zero-based line numbers                           |
| `cursor`             | Previous `nextCursor`; resend identical URI, query and options        |

Globs: `*`/`?` within segments, `**` across segments, `**/` for zero or more directory
segments. Patterns without `/` match basenames; others match paths relative to the
search directory. Filenames match case-sensitively; braces/classes are literal.
Example: `include: ["**/*.ts"]`, `exclude: ["vendor/**", "*.test.ts"]`.
Filters select files; excluded directories are still traversed.

## Continuation and consistency

Responses declare `consistency: "live"`. `nextCursor` means remaining work and
sets `truncated`/`incomplete`; continue until absent. `filesSearched` counts this
page's examined files, including resumed files. Positions use zero-based UTF-16;
context lines are clipped to 1,000 characters and match previews are bounded.
Each serialized result envelope is limited to 24,000 characters, including URI,
query, previews, context and errors. This leaves room for long virtual URIs and
one match while keeping ordinary pages small. The next cursor resumes the exact
first match not returned, including when output rather than match count fills
the page. A first match may shorten its preview or context to fit;
`previewTruncated: true` signals that reduction. Full match URIs and positions
are preserved. Excess error details are omitted with `limits: ["errors"]`.
If unusually large escaped URI/query text leaves no room for even a minimal
match, the request fails explicitly with `LIMIT_EXCEEDED`; narrow the URI or
query. No empty continuation loop silently skips that match.

Cursors are single-use, option-bound and bridge-local, expiring five minutes after
the initial search. A preflight `LIMIT_EXCEEDED` for active-search capacity does not
consume an unexpired cursor; retry it when capacity is available. Restart without a cursor after root changes, bridge stop,
continued-file changes, expiry, replay, option changes or eviction. Every HTTP
request is authenticated; cancellation discards consumed continuations. Maximum:
16 idle cursors and 16 active searches, evicting oldest idle cursors first. Expired
idle entries are released on the next search or stop.

Search is not atomic: directories are enumerated once, later additions may be
absent, and earlier matches may become stale. Continued files require matching
version/content fingerprints. Cursor state stores traversal positions, fingerprints
and counters, never source/query text, credentials, persistent indexes or disk caches.

## Bounds

Per page: default 20 results (explicit maximum 100), 24,000 serialized output characters, 200 files, 2,000 traversal steps, 4 MiB examined text and
one million filename-matching state transitions. Files allow 1 MiB. Continuations
resume at the next match offset; buffer revalidation counts toward cumulative
bytes. One extra bounded buffer may be inspected before yielding at the byte limit.

Cumulative limits: 12 directory levels, 2,000 pending entries or 128 Ki UTF-16 URI
characters, 8,192 characters per URI, 20,000 traversal steps, 64 MiB examined buffers
and 1,000 pages. In `limits`, `filterWork` marks expensive-filter termination;
`totalWork` marks overall exhaustion. Other limits omit unsafe/excess
entries while retained work can continue. Provider `readDirectory` returns a
whole array; the bridge retains a bounded subset but cannot paginate that call.

Inspect `incomplete`, `errors` and `limits` on every page, including the last.
Omissions/unreadable entries prevent completeness. Narrow `uri` or filters to
reduce work.
