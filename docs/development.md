# Development, review and release rules

## Branches

- `main` is the stable integration branch. No direct development pushes, force
  pushes or deletion. GitHub's initial license commit is the only bootstrap seed.
- Start a short-lived `feat/<topic>`, `fix/<topic>`, `docs/<topic>` or
  `chore/<topic>` branch from current main. Do not use a permanent develop branch.
- Keep a PR focused. Use descriptive commits; never rewrite a shared branch
  without the owner's explicit agreement. Never include customer code or secrets.

## Checks and code quality

- Keep runtime code small and focused. Use the official MCP SDK rather than a
  bespoke protocol implementation. Pin dependencies and commit the lockfile.
- Run Prettier and a separate simplification review. Prefer standard library
  operations to custom helpers where they preserve the safety contract.
- Required verification: `npm run check`, `npm run format:check`, `npm test`,
  `npm run test:vscode`, `npm run package`, and a production dependency audit.
- Record actual results and limitations. Synthetic VFS tests never count as
  SAP-backend or native-client acceptance. A check that could not run is pending.
- Installing and running VS Code/SAP ADT for tests may use Microsoft/SAP network
  services, including their telemetry. The project's own runtime must not emit
  telemetry. Keep third-party tools and test profiles isolated from the product.

## Pull requests and reviews

- All development reaches main through a PR. Use draft PRs while checks are
  incomplete. Describe the problem, changed behavior and validation evidence.
- Every PR requires Codex cloud review. Enable automatic reviews in Codex
  repository settings. If automatic review does not run, request `@codex review`
  explicitly and verify that a review actually completed.
- Address consequential findings and resolve review conversations. A request,
  emoji acknowledgement or missing report is not proof of completed review.
- Every PR also requires CodeRabbit review. Request a new review with
  `@coderabbitai review` after pushing the changes to be reviewed; this command
  is authorized by the owner. Verify completion, including after a run was
  interrupted by a changed base or head.
- Before declaring a PR complete or ready to merge, all three gates must pass
  for its current head: GitHub CI, Codex review and CodeRabbit review. Both
  reviewers must have no unresolved consequential findings. Record the reviewed
  revision and result; an old clean review does not cover later commits. Findings
  may be fixed or dismissed with documented technical evidence.
- Before declaring the initial delivery complete and before releases, run an
  actual Codex Security repository scan and record the scanned revision/result.
  Security-sensitive PRs also need Security Review. `npm audit`, CodeQL and a
  manual code review are useful additional checks, not substitutes for this scan.
- Cloud review settings are account-side settings; adding YAML or this document
  does not enable them. Report missing access rather than claiming configuration.

## Merging

### Completion evidence

Before the final handoff, record the current head SHA and links to the completed
CI run, Codex result and CodeRabbit result. Re-read the head after collecting the
evidence; if it changed, repeat verification for the new revision.

- Check both review findings and formal GitHub review state. A clean comment or
  successful bot status does not supersede that bot's earlier `CHANGES_REQUESTED`.
  Ask the reviewer to complete its formal re-review; do not dismiss the review or
  weaken branch protection to make the PR mergeable.
- Verify all review conversations are resolved and required checks have finished
  successfully. Pending, unavailable, interrupted and stale reviews are pending,
  not successful. Check both commit statuses and check runs.
- Once the current-head gates pass, mark the draft ready. Await any automatic
  reviews triggered by that transition and handle new findings before handoff.
  Codex's documented clean-result thumbs-up can confirm a completed review when
  it is attributable to the latest review trigger and unchanged head; an eyes
  reaction or an older thumbs-up is not completion evidence.
- Read GitHub's actual merge gate from the authenticated PR page or REST PR
  response. `mergeable: true` means no merge conflict, not permission to merge.
  Require `mergeable_state: clean` for the normal handoff. If it is blocked,
  unknown or pending, identify the remaining gate and do not report readiness.
- Report the reviewed SHA, completed gates and any material validation limits.
  Leave Squash and Merge to the owner. Do not end a review watcher merely because
  the code checks are green while the actual merge gate remains blocked.

### Owner-controlled integration

- The owner decides when to merge. Agents must not merge without an explicit
  instruction for that PR. No auto-merge.
- Require passing CI, resolved review conversations and clean completed Codex
  and CodeRabbit reviews for the current head.
- Squash merge is preferred to keep main's history linear; preserve the PR's
  rationale and validation summary in the resulting commit description.
- Branch protection applies to administrators too. Do not bypass or temporarily
  disable it. After merge, the source branch may be deleted through GitHub.
- Codex may report a clean review without a GitHub approval; do not require an
  impossible self-approval from the repository's sole maintainer as a substitute.

## Releases

- PR CI produces a downloadable VSIX artifact, not a Marketplace publication.
- No release, tag or Marketplace publish in the initial implementation task.
- A future release requires owner approval, version/changelog update, passing
  checks, documented SAP acceptance and a completed Codex Security scan.
- Marketplace publisher registration, credentials and signing/provenance are a
  separate future task. Do not store publishing tokens in this repository.
