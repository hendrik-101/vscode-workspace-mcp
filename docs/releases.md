# Preview releases

## Current distribution

Install a [main CI artifact](https://github.com/hendrik-101/vscode-workspace-mcp/actions/workflows/ci.yml?query=branch%3Amain)
or build from source. CI artifacts expire after 14 days and require GitHub sign-in.
No Marketplace publication is available. Release preparation does not assert that
SAP/client acceptance, Security scans or publisher registration have passed.

## Prepare a draft

Only the repository owner can manually run **Prepare preview release**, selecting
`main`. Dispatch is approval to create a draft GitHub prerelease and attach a VSIX;
it does not authorize public release or Marketplace publication.

Before dispatch:

1. Merge reviewed changes through the [development gates](development.md). Record
   the full main commit SHA with passing current-head CI and reviews.
2. Set a new numeric `major.minor.patch` version in `package.json` and both lockfile
   entries. Add its release notes to `CHANGELOG.md`. The first candidate remains
   `0.1.0`; do not add a `-beta` suffix. VS Code previews use `vsce --pre-release`;
   the GitHub prerelease flag is separate.
3. Complete [real SAP and native-client acceptance](acceptance.md) and an actual
   Codex Security repository scan for that revision. Provide redacted evidence
   references and results as dispatch inputs. These are owner-reviewed evidence,
   not automatically verified attestations; synthetic tests and PR reviews are
   not substitutes. Do not put private findings or system details in release notes.

The workflow requires a commit reachable from main, matching versions, nonempty
changelog notes and an unused `v<version>` tag/release. It reruns checks, unit and
VS Code tests, ADT coexistence and production dependency audit, then packages a
preview VSIX, calculates SHA256 and creates a **draft** GitHub prerelease with
revision, notes and evidence references. Existing releases are never overwritten.
If a run fails after draft creation, inspect and repair the draft manually.

Review the draft and test the attached VSIX. Publishing it, creating its public
tag or publishing to the Marketplace requires a separate owner decision. There
is no automatic publication trigger and no Marketplace token in this workflow.

## Marketplace gate

Before Marketplace publication, verify ownership/registration of publisher
`hendrik-101`, listing and icon, licensing/notices, signing/provenance decisions,
and the version/channel policy. Configure publishing credentials outside this
repository only when publication is explicitly approved. Keep supported host and
client requirements and unverified compatibility limits visible in the listing.
