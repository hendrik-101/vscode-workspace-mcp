# Directory listing

`list_directory` accepts a workspace `uri`, optional `maxEntries` (1–100,
default 50), and a previous `nextCursor`. Resend the URI and page size to
continue. Pages fit a 16,000-character serialized response budget.

The provider returns its entire directory array. The bridge examines at most
the first 1,000 entries in provider order; it cannot paginate the provider call.
`omittedEntries` reports entries beyond that scan and entries too large to return.
`blockedEntries` reports unsafe names and symbolic links in the scanned subset.
These omissions set `incomplete`, including on the final page. `truncated` also
reports remaining pages. Inspect these fields even when `nextCursor` is absent.

Cursors contain an offset and a fingerprint bound to the URI, page size, current
workspace roots and scanned listing. An unchanged listing can be paged without
duplicates; changed listings or root context require restarting. No listing cache
or source text is retained. Changes outside the scanned subset are not observed,
except changes to the provider's total entry count. Listings are live observations,
not atomic snapshots. Provider order changes also invalidate continuation.

Implementation steps: first add virtual-provider pagination, mutation and budget
regressions; then extend the input/result contracts and bounded listing loop;
finally verify MCP schema acceptance, full checks and a simplification review.
