# Releases

## Builds and deliberate releases

PRs and merges to `main` run CI and produce VSIX artifacts on Linux, Windows and
macOS. They do not publish. The owner deliberately pushes an annotated `vX.Y.Z`
tag to authorize automatic GitHub and Marketplace publication of that version,
but only after explicitly enabling the repository publishing switch.
The tag must point to a commit reachable from `main`. Release tags are never moved
or reused. Protect `v*` tags with a GitHub ruleset allowing creation only by the repository
owner and blocking updates and deletion without bypass permissions.

The **Publish tagged release** workflow validates the tag, then reuses the complete
three-platform CI workflow. Its packaged tests install the actual uploaded VSIX,
including upgrade/reinstall checks. It publishes the tested Linux artifact as one
platform-independent VSIX, with SHA256 and release notes. A separate job publishes
that same artifact to VS Code Marketplace under `hendrik101`.
The GitHub publication job does not check out or execute repository scripts.
The Marketplace job checks out the validated commit without persisted credentials
and installs its reviewed lockfile with `npm ci --ignore-scripts` before
Marketplace authentication. Package-manager caching is disabled; both authentication
paths invoke the local locked `vsce` binary. No repository scripts or dependency
lifecycle hooks run in that job. GitHub and Marketplace publication are jobs in
one workflow, avoiding reliance on events created by `GITHUB_TOKEN` to start
another workflow.

## Prepared, disabled by default

The tag-release pipeline is prepared but disabled. Its entry job requires the
repository Actions variable `RELEASE_PUBLISHING_ENABLED` to equal the string
`true`. An absent, empty or different value skips all tag-release jobs, including
GitHub and Marketplace publication. A tag event can still appear as a skipped
workflow run; it does not allocate runners or publish anything.

Keep this variable unset while preparing the publisher identity and reviewing the
PR. The existing manually dispatched preview workflow remains available; it is
not started by a merge or tag and must not be dispatched during preparation.
Regular PR/main CI continues to build and test.

When the owner is ready to activate publishing:

1. Merge the reviewed release PR, finish the authentication setup below and protect
   release tags. Complete the real acceptance and Security scan for the release.
2. Verify the publisher dependency-lock remediation in the reviewed release
   revision: the Marketplace job checks out the validated SHA without persisted
   credentials, disables package-manager caching, runs `npm ci --ignore-scripts`
   before authentication and uses the local `vsce` binary for both authentication
   paths. Confirm the lockfile is reviewed and current-head CI and security review
   pass. Do not enable publishing while this remediation or verification is pending.
3. In repository **Settings → Secrets and variables → Actions → Variables**, create
   the repository variable `RELEASE_PUBLISHING_ENABLED` with value `true`.
4. As the repository owner, push a new, unused annotated release tag as described
   below. Tags pushed by another account are skipped. Enabling the variable does
   not replay earlier tag events; do not reuse or move skipped tags. An owner rerun
   retains the original push actor and cannot authorize a non-owner tag event.

To suspend future tag releases, delete the variable or set it to `false`.
This is an entry gate, not cancellation of a release that has already started.
Cancel any already-running release separately if needed.

### Cost boundary

Keep this repository public and use the configured standard GitHub-hosted runners.
Their Actions usage is free for public repositories; no paid runner is configured.
Use Entra's free workload identity federation features with an application/service
principal. No Workload ID Premium license or Azure compute/storage deployment is
needed for this pipeline. Establishing the Microsoft account/tenant is a separate
one-time setup; do not purchase premium licenses or enable paid resources for it.
GitHub Releases and VS Code Marketplace publishing require no paid publishing plan.
AI review services have their own account quotas; this workflow does not purchase
additional review capacity or call a metered AI API.

See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [Entra free/Premium capabilities](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-faqs).

## Prepare a version

1. Merge reviewed changes through the [development gates](development.md).
2. Set a numeric version in `package.json` and both lockfile entries and add one
   nonempty matching `CHANGELOG.md` entry. Publisher must remain `hendrik101`.
3. Complete [real SAP/native-client acceptance](acceptance.md) and an actual
   Codex Security repository scan for the exact intended release revision.
   Keep redacted evidence references for that commit. PR reviews and synthetic
   tests do not substitute for these checks.
4. Prepare an annotated tag message with exactly one of each field:

```text
Workspace MCP 0.1.0

Channel: preview
Acceptance: redacted reference to completed real SAP/client checks for this commit
Security: redacted reference to completed Codex Security repository scan for this commit
```

These references are owner-reviewed evidence, not automatically verified
attestations. Do not publish tokens, SAP system details, private findings or sources
in annotations or release notes. Replace the example references with real evidence.

5. After CI is green, publication authentication is configured and the repository
   publishing switch is enabled, tag the exact
   approved main commit and push it using the repository owner's account (not a
   bot or another collaborator). This explicit action authorizes both publications:

```sh
git tag -a v0.1.0 <approved-main-commit-sha> -F <tag-message-file>
git push origin refs/tags/v0.1.0
```

The first version is `0.1.0` with `Channel: preview`. It becomes a GitHub prerelease
and a Marketplace pre-release (`--pre-release`). Do not append `-beta` to versions.
For stable releases use `Channel: stable` and set `preview: false` in the manifest
in the release PR. Follow VS Code's recommended odd-minor preview/even-minor stable
policy (e.g. `0.1.x` preview, `0.2.x` stable). Version numbers cannot be reused
across the Marketplace stable and pre-release channels.

## Marketplace authentication: one-time owner setup

Publisher `hendrik101` is registered. Configure a GitHub environment named
**marketplace** and restrict its deployment tags to `v*`. Environment reviewer
approval is optional: without it, the owner's tag is the deliberate authorization.
This repository contains no publishing credentials. Registration alone does not
authorize a GitHub runner to publish.

### Microsoft Entra workload federation (default)

This route uses short-lived credentials, with no stored client secret:

1. Create an Entra application/service principal (or a user-assigned managed
   identity) in a tenant you control.
2. Add its federated credential with:
   - issuer: `https://token.actions.githubusercontent.com`
   - audience: `api://AzureADTokenExchange`
   - subject: `repo:hendrik-101/vscode-workspace-mcp:environment:marketplace`
3. Add environment secrets `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. Keep
   `MARKETPLACE_AUTH` unset or set its environment variable to `entra`.
   `azure/login` uses OIDC with `allow-no-subscriptions: true`; this publishing
   job does not access Azure resource subscriptions.
4. Authenticate as that identity and obtain its Azure DevOps profile ID:

```sh
az rest --url https://app.vssps.visualstudio.com/_apis/profile/profiles/me \
  --resource 499b84ac-1321-427f-aa17-267ca6975798
```

5. In Marketplace publisher management for `hendrik101`, add that returned `id`
   as a member with the **Contributor** role. Identity provisioning/authorization
   must be completed before the first tag; an identity lookup failure is not a
   successful setup. The workflow then uses `vsce publish --azure-credential`.

See Microsoft's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
and [Azure Login OIDC guidance](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended).

### Explicit PAT option

If using an existing supported Azure DevOps PAT instead, set environment variable
`MARKETPLACE_AUTH` to `pat` and environment secret `VSCE_PAT` to a token with
Marketplace **Manage** scope belonging to an account authorized for `hendrik101`.
The workflow never falls back between authentication methods. Keep tokens out of
Git, commands and chat. Microsoft announces retirement of global Azure DevOps PATs
on December 1, 2026; this option must not be treated as the long-term default.

## First preview and recovery

The existing owner-dispatched **Prepare preview release** workflow remains
available to produce a draft GitHub prerelease for inspection before the first
public release. Dispatch still requires exact commit, version and real acceptance/
Security evidence. It does not publish to Marketplace. Do not publish that draft
and then try to create a second release with the same tag through the tag workflow;
choose one route for a version. A discarded draft may be deleted before pushing
its as-yet-unused tag.

If GitHub publication succeeds and Marketplace fails, GitHub's release remains
available. Fix the authentication/configuration and use **Re-run failed jobs**
while artifacts are retained (14 days). Do not move the tag or rerun successful
publication jobs: GitHub and Marketplace reject duplicate versions. If artifacts
expire, download the exact VSIX and checksum from the GitHub release, verify the
checksum and upload that file manually to Marketplace. Do not rebuild an existing
release or overwrite its assets.

If upgrading from an old development VSIX with publisher `hendrik-101`, uninstall
that development extension before installing `hendrik101.vscode-workspace-mcp`.
VS Code treats them as different extensions. Run Start and copy fresh connection
settings; old SecretStorage and adapter paths belong to the old extension ID.
