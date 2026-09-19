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
