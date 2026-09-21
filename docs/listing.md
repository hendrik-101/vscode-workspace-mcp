# Directory listing

`list_directory` accepts a workspace `uri`, optional `maxEntries` (1–100,
default 50), and optional `cursor`. To continue, pass the returned `nextCursor`
as the input `cursor` and resend the unchanged URI and page size. Pages fit a
16,000-character serialized response budget.

The provider returns its entire directory array. The bridge examines at most
the first 1,000 entries in provider order; it cannot paginate the provider call.
`omittedEntries` reports entries beyond that scan and entries too large to return.
`blockedEntries` reports unsafe names and symbolic links in the scanned subset.
These omissions set `incomplete`, including on the final page. `truncated` also
reports remaining pages. Inspect these fields even when `nextCursor` is absent.

Cursors contain an offset authenticated with a service-local ephemeral key and a
fingerprint bound to the URI, page size, current workspace roots and scanned
listing. Altered offsets and cursors from a restarted bridge are rejected. An
unchanged listing can be paged without duplicates; changed listings or root
context require restarting. No listing cache or source text is retained.

Fingerprinting processes one bounded entry representation at a time. Names longer
than 8,192 characters are always omitted and represented only by their position,
length and type. Changes confined to the contents of an equally long omitted name
do not invalidate continuation; making that entry returnable does. Changes outside
the scanned subset are not observed, except changes to the provider's total entry
count. Listings are live observations, not atomic snapshots. Changes to the
ordering of returnable entries also invalidate continuation.

Implementation steps: first add virtual-provider pagination, mutation and budget
regressions; then extend the input/result contracts and bounded listing loop;
finally verify MCP schema acceptance, full checks and a simplification review.
