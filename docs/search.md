# Progressive workspace search

`search_workspace` searches single-line literal text in live VS Code documents,
including unsaved buffers and virtual filesystem URIs. Its existing `uri`,
`query` and `maxResults` inputs remain valid. Matching is case-sensitive by default.

Optional inputs:

| Input                | Meaning                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `include`, `exclude` | Up to 20 filename globs each, up to 256 characters per glob. Exclusion wins.         |
| `caseSensitive`      | Defaults to `true`; false uses Unicode-aware case-insensitive literal matching.      |
| `wholeWord`          | Defaults to `false`; word boundaries use ASCII letters, digits and underscore.       |
| `contextLines`       | 0–5 neighboring lines on each side, returned with zero-based line numbers.           |
| `cursor`             | Opaque `nextCursor` from the previous page. Resend identical URI, query and options. |

Filename globs support `*` and `?` within a path segment, `**` across segments,
and `**/` for zero or more directory segments. Patterns without `/` match the
basename; patterns with `/` match paths relative to the requested search directory.
Matching filenames is case-sensitive. Braces and character classes are literal.
For example, `include: ["**/*.ts"]`, `exclude: ["vendor/**", "*.test.ts"]`.
Excluded directories are still traversed; these filters select files.

Each response includes `consistency: "live"`. If `nextCursor` is present, more
work remains and `truncated`/`incomplete` are true. Continue until no cursor
remains. `filesSearched` counts files examined on this page (a resumed file counts
again). Match positions are zero-based UTF-16 positions. Context lines are
clipped to 1000 characters; match previews retain the existing bounded behavior.

A cursor is single-use, bound to its options and running bridge, and expires five
minutes after the initial search. Root changes, stopping the bridge, document
changes while continuing that file, expiry, replay, option changes or eviction
require restarting without a cursor. Authentication is checked on every HTTP
request. Cancellation discards the consumed continuation. At most 16 idle cursors
and 16 active searches are retained; oldest idle cursors are evicted first.
Expired idle entries are released on the next search or bridge stop.

This is not an atomic workspace snapshot. Directories are enumerated once; files
added after enumeration may be absent, and earlier matches can become stale.
A continued file is checked against its version and content fingerprint. No source
text, query text, credential, persistent source index or disk cache is stored in
cursor state; only URI traversal positions, fingerprints and counters are retained.

Pages are bounded by 100 results, 200 files, 2000 traversal steps and 4 MiB of
examined text. Files retain the existing 1 MiB size limit. Continued matching
resumes at the next offset rather than rescanning earlier matches; validating the
live buffer rereads its bounded text and counts toward the overall byte budget.
A page may inspect one extra bounded buffer before yielding at its byte limit.

Hard limits are cumulative and reported in `limits`: 12 directory levels, 2000
pending entries or 128 Ki UTF-16 URI characters, 8192 characters per URI, 20,000
traversal steps, 64 MiB of examined buffers, 1000 pages and one million filename
matching state transitions per page. `filterWork` terminates an overly expensive
filter search; `totalWork` terminates overall budget exhaustion. Other limits omit
unsafe or excess entries while permitting continuation of retained work. Provider
`readDirectory` returns an entire array before the bridge can bound it; only a
bounded subset is retained. There is no pagination API for that provider call.

Inspect `incomplete`, `errors`, and `limits` even on the final page. Hard-limit
omissions and unreadable entries make the final result incomplete; they are not
silently reported as a complete search. Narrowing `uri` or filters can reduce work.
