# Discoverable tool contracts

## Scope

Make tool selection and parameters understandable from `tools/list`: preserve full
URIs, use zero-based UTF-16 positions and exclusive range ends, state defaults,
and pass search `nextCursor` back as `cursor` with identical options. Prefer
symbols for known names and direct small reads for known files; use literal search
for text. Keep startup guidance short and avoid speculative full-file reads.

Expose compact, typed success output schemas under the existing `{ result }`
envelope. Share authoring primitives, omit repeated output descriptions and
constraints already enforced by workspace operations, and measure expanded wire
size. Result objects accept and preserve additive fields so independently merged
pagination/count metadata remains visible. Formatting edits are optional to allow
compact apply responses; existing result fields retain their types. MCP
`isError: true` responses retain the redacted `{ error: { code, message } }`
envelope. Both optional fields are advertised because the SDK client validates
structured errors too; a JSON Schema `oneOf` and runtime refinement enforce
exactly one field.

Refactoring previews add `previewAvailable` (a visible text edit exists) and
`applicationSupported: false`. Preserve `supported: false` as the legacy alias for
application support, alongside `applicable: false` and `complete: false`. Empty
previews do not establish provider availability. No pagination, size, application,
write-policy or provider behavior changes are included.

## Steps and verification

1. Add failing MCP discovery, cursor round-trip and output-validation tests, plus
   preview-availability tests against the workspace service.
2. Add concise descriptions, shared output schema primitives and explicit preview
   flags; update plugin selection guidance and refactoring docs.
3. Run focused tests, inspect schema cost and simplify separately. Run typecheck,
   formatting, the full unit suite, VS Code tests, packaging and dependency audit.
   Report unavailable checks and external review gates honestly.

## Context cost

Run `npm run measure:context` to reproduce the current 20-tool measurement,
including the registered `read_symbol`. `npm test` also runs the context budget
check. The harness starts the real server on loopback and uses the official MCP
SDK client. Its fetch wrapper measures the actual UTF-8 JSON response body before
the SDK parses it; this includes the JSON-RPC envelope but excludes HTTP headers,
TLS framing, requests and initialization. It separately reports compact JSON sizes
for each advertised tool definition, its input/output schemas, and tool results.
The SDK validates the representative structured results against discovered schemas.

Baseline with SDK 1.30.0 and Node 24.19.0:

| Discovery component                      |  Bytes |
| ---------------------------------------- | -----: |
| Complete `tools/list` response body      | 58,314 |
| Parsed `tools/list` result, compact JSON | 58,280 |
| Sum of 20 input schemas                  | 20,467 |
| Sum of 20 output schemas                 | 29,377 |
| Complete `read_symbol` definition        |  5,231 |

The full discovery body is approximately **14,579 tokens at four bytes per token**.
This is a rough size estimate, not a tokenizer count or measured Codex/Claude
prompt cost. Native clients may transform definitions, omit output schemas, lazily
discover tools, cache definitions or inject additional instructions. Neither their
prompt assembly nor native tokenizer usage is observable in this harness.

Representative responses use deterministic synthetic provider results, following
the existing server-test fixture. Read pages contain 2,048 ASCII characters with
continuation metadata; search returns 20 short matches with a cursor; diagnostics
returns 10 warnings with a next offset; the save call returns a redacted version
conflict. These are illustrative bounded pages, **not maximum-size responses** or
a test of workspace clipping/provider behavior. The separate workspace tests cover
budget enforcement, UTF-16 boundaries and continuation correctness.

| Response              | Wire bytes | Structured JSON bytes | Estimated tokens (wire bytes / 4, rounded up) | Test ceiling (bytes) |
| --------------------- | ---------: | --------------------: | --------------------------------------------: | -------------------: |
| `read_document`       |      4,998 |                 2,422 |                                         1,250 |                6,000 |
| `read_symbol`         |      5,428 |                 2,619 |                                         1,357 |                6,500 |
| `search_workspace`    |      5,614 |                 2,605 |                                         1,404 |                6,500 |
| `get_diagnostics`     |      4,498 |                 2,065 |                                         1,125 |                5,500 |
| `save_document` error |        369 |                   125 |                                            93 |                  600 |

The transport carries both text content and structured content; counting only the
structured envelope understates wire cost. Client-specific rendering determines
whether both representations enter model context. UTF-8 bytes also differ from
UTF-16 source budgets, especially for non-ASCII text and JSON escaping.

The discovery ceiling is 64,000 bytes (about 10% headroom), with separate response
ceilings above. These are review triggers, not exact snapshots or hard runtime
limits. Intentional contract/fixture changes should rerun the report, explain the
cost and update the ceilings only when justified. Shared schema primitives keep
authoring small but do not deduplicate expanded wire schemas. No production schema
redesign is included in this measurement change.

## Independent integration

The registered `read_symbol` output schema matches the bounded `ReadSymbolResult`,
including symbol name, kind, full range, selection range and optional immediate
container. It preserves additive read/symbol fields and is included in all 20-tool
figures above, superseding the historical 19-output-schema-only estimate.

Merged read ranges, read continuation, listing omissions/cursors, search preview
truncation and formatting edit counts are declared explicitly for discovery.
Document symbol results require a positive integer live document version for continuation;
workspace symbol results may omit it. Symbol kind names, full-range knowledge and scan state, diagnostic counts,
snapshots and message clipping flags, listing omission/completeness fields, and
search consistency/limits are required because the merged implementations always
return them. Conditional continuations, symbol selection/container fields,
diagnostic source/code fields and their clipping flags remain optional. Loose
objects still preserve future additions.
