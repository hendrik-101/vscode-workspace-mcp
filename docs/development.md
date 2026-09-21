# Development rules

## Branches and validation

- Branch from current `main`: `feat/`, `fix/`, `docs/` or `chore/` plus a topic.
  Keep PRs focused and commits descriptive; no permanent develop branch.
- No direct development pushes, force pushes or deletion of `main`. Its initial
  GitHub license commit was the bootstrap exception. Never rewrite a shared
  branch without owner agreement or commit customer code/secrets.
- Keep runtime code small; use the official MCP SDK and standard operations where
  they preserve safety. Pin dependencies and commit the lockfile.
- Run Prettier and a separate simplification review. Required verification:
  `npm run check`, `npm run format:check`, `npm test`, `npm run test:vscode`,
  `npm run package` and a production dependency audit.
- Record results and limitations; unrun checks remain pending. Synthetic tests
  cannot establish SAP-backend/native-client acceptance.
- Isolated VS Code/SAP ADT test profiles may use Microsoft/SAP downloads and
  telemetry. Product runtime must emit none.

## Review and handoff

Use draft PRs until checks complete. Describe the problem, changes and validation.
Every PR requires GitHub CI, Codex cloud review and CodeRabbit for its **current
head**, with no unresolved consequential findings.

Enable automatic Codex reviews in account-side repository settings; repository
YAML cannot enable them. Report unavailable access. If automatic review does not
run, request `@codex review`. After pushing changes, request
`@coderabbitai review` (owner-authorized). Verify completion after interrupted runs
or base/head changes. Fix findings or dismiss them with technical evidence.

Before handoff:

1. Record head SHA and links to completed CI, Codex and CodeRabbit results. Check
   both commit statuses and check runs. Pending, unavailable, interrupted or stale
   results do not pass; a request or acknowledgement proves nothing.
2. Resolve every review conversation. Inspect formal reviews too: a clean comment
   or status does not supersede `CHANGES_REQUESTED`. Obtain the reviewer's formal
   re-review; never dismiss it or weaken protection to unblock merging.
3. Mark the draft ready only after current-head gates pass. Await automatic
   reviews triggered by that transition and address new findings. Codex's
   documented clean-result thumbs-up counts only when attributable to the latest
   trigger and unchanged head; eyes or older thumbs-up reactions do not.
4. Read GitHub's authenticated PR page or REST merge gate. Require
   `mergeable_state: clean`; `mergeable: true` proves only absence of conflicts.
   Identify blocked, unknown or pending gates and continue watching.
5. Re-read the head; repeat verification if it changed. Report reviewed SHA,
   evidence and validation limits. Leave **Squash and Merge** to the owner.

Codex can finish cleanly without a formal approval. Do not substitute an impossible
self-approval by the sole maintainer. Owner authorization is required for each
merge; no auto-merge or administrator bypass. Prefer squash merges with rationale
and validation in the commit. GitHub may delete the source branch after merging.

## Security scans and releases

Before initial-delivery completion and every release, run an actual Codex Security
repository scan and record its revision/result. Security-sensitive PRs also need
Security Review. PR reviews, `npm audit`, CodeQL and manual review do not replace
the repository scan.

PR CI produces a VSIX artifact, never a publication. The initial implementation
authorizes no release, tag or Marketplace publish. Future releases require owner
approval, version/changelog updates, passing checks, documented SAP acceptance
and the Security scan. Publisher registration, credentials and signing/provenance
remain separate work; never store publishing tokens here.
