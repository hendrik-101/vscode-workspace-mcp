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

The 19 expanded output schemas add 26,532 bytes of schema JSON (approximately
6,633 tokens at four bytes per token; this is an estimate, not a tokenizer count).
Clients that eagerly inject every tool definition incur this cost; lazy discovery
may defer it. Shared primitives keep authoring small but do not deduplicate wire
schemas. Shapes retain typed fields and arrays while avoiding repeated bounds and
verbose output descriptions. Per-tool references would save little because each
range generally appears once within a schema, and definitions cannot be shared
across separate tool schemas. Publishing merged read/list/search/format metadata
and required symbol/diagnostic metadata adds 4,551 bytes over the initial schemas.

## Independent integration

The internal `read_symbol` output schema matches the sibling symbol-reading PR's
bounded `ReadSymbolResult`, including symbol name, kind, full range, selection
range and optional immediate container. It preserves additive read/symbol fields.
This entry alone exposes no tool or new capability; registration is supplied by
the separate PR. The 19-tool discovery cost above excludes this dormant schema.

Merged read ranges, read continuation, listing omissions/cursors, search preview
truncation and formatting edit counts are declared explicitly for discovery.
Document symbol results require a positive integer live document version for continuation;
workspace symbol results may omit it. Symbol kind names, full-range knowledge and scan state, diagnostic counts,
snapshots and message clipping flags, listing omission/completeness fields, and
search consistency/limits are required because the merged implementations always
return them. Conditional continuations, symbol selection/container fields,
diagnostic source/code fields and their clipping flags remain optional. Loose
objects still preserve future additions.
