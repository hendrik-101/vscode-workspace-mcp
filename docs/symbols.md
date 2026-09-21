# Bounded symbol discovery

`document_symbols` and `workspace_symbols` return 20 results by default;
`maxResults` accepts 1–100. Both support a case-insensitive literal `name`
substring filter on the bounded displayed name (1–1000 characters), an exact `kind` filter (VS Code numeric
kind or lowercase type name), and an `offset` into admitted, filtered results.
Keep filters unchanged when following `nextOffset`. The existing workspace
`query` remains required and is passed to the provider unchanged.

Every result retains numeric `kind` and adds readable `type`. Hierarchical
results preserve provider `range` and `selectionRange` separately. `fullRangeKnown`
is true only when valid, ordered ranges show a distinct selection contained in
the body range. VS Code normalizes legacy SymbolInformation into hierarchical
objects with identical range and selectionRange; these remain explicitly unknown,
as do genuine DocumentSymbols whose ranges coincide. Flat SymbolInformation
retains its provider location as `range`, with `fullRangeKnown: false` and no
invented selection or body range. The flag is deliberately conservative: unknown
does not prove that a range is incomplete. This corrects the old document `range`
behavior, which discarded the provider's full range.
Each page caps combined name/container/URI text at 32 Ki characters, so it may
return fewer than maxResults and still provide nextOffset. Individual
names/container names are capped at 1000 characters; targets longer than 8192
characters are omitted. External, unsafe, inaccessible and symlink targets
remain omitted. No document text or provider detail is included.

Document responses include `version` and `consistency: "document-version"`.
Optional input `version` rejects stale requests and is required with nonzero
offset. Changes, closure or replacement of the document during a provider call
or target admission reject with VERSION_CONFLICT. Pagination reruns the provider;
a matching document version cannot guarantee stable provider order/index state,
or detect a close/reopen between requests whose version number was reused.
Workspace responses explicitly use `consistency: "live"`: each page reruns the
provider, so index changes can duplicate or skip results. Neither mode retains
server cursors or claims snapshot consistency.

Each request inspects at most 1000 provider nodes, in provider order (depth-first
for trees). `scanned` counts inspected nodes, `scanLimitReached` means additional
nodes were not inspected, and `omitted` counts rejected inspected targets. Filter
mismatches are not omissions. `nextOffset` exists only for known additional
admitted matches within that scan; `truncated` is true for those matches or an
incomplete scan. A scan-limited last page cannot establish exhaustiveness;
narrow the provider query or document instead. Empty results do not establish
provider availability. Provider commands themselves can allocate larger results.

Implementation sequence: add contract/regression tests; implement bounded
flattening, filtering and pagination; enforce document identity/version checks;
expose strict tool schemas; update integration expectations; run local gates and
review simplification. No writes, filesystem/path fallback, or new provider
commands are introduced.
