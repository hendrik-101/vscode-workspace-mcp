# Formatting response size

## Contract

`format_document` always validates the complete formatter result before applying
any edit. Limits allow 10,000 edits and 8 MiB of replacement text; the input and resulting
document must each fit within 8 MiB. It
never applies a truncated edit set and never implicitly saves.

With `apply: true`, the default response contains document `uri`, `version`,
`dirty`, `applied` and `editCount`; it omits `edits`. `includeEdits: true` explicitly
returns the complete edits as well. With `apply` omitted or false, edits remain
included by default for compatibility. `includeEdits: false` requests just the
summary for either mode. `editCount` always counts the complete validated set.
An empty result has `editCount: 0` and `applied: false`, including when application
was requested. Empty results do not establish formatter availability.

The preview and explicit full-edit response retain the 8 MiB replacement
text limit; this change does not impose a 16,000-character response budget or
introduce continuation tokens. Large single replacement edits remain whole.
Callers that only need state should use the compact summary. Edit ranges refer
to the requested input version, even when the response reports a newer applied
version: echoed edits must not be applied again.

Full previews can exceed a client's receive buffer: the MCP response carries
both textual and structured representations of edits, with additional JSON
escaping. Clients that request full 8 MiB previews must accept up to 128 MiB per
response; the TypeScript SDK's default 10 MiB stdio receive buffer is insufficient.
Use `includeEdits: false` for a compact preview summary or the default summary
after application when the client cannot increase its receive limit. The bridge
cannot configure another process's receive buffer.

## Implementation and validation steps

1. Add failing integration assertions for summary defaults, explicit inclusion,
   preview compatibility, response-size savings and the full resulting buffer.
2. Add `includeEdits` to the tool schema and input contract, make response edits
   optional, and always return `editCount`.
3. Preserve existing provider validation and guarded edit calls; change only the
   response projection. Confirm write denial, version conflicts, dirty state and
   no implicit saves through the existing integration suite.
4. Run type checking, formatting, unit tests, VS Code integration, packaging and
   production dependency audit. Review the diff separately for simplification.
