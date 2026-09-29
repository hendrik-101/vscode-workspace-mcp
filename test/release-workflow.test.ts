import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/preview-release.yml", "utf8");
const [prepare, draft] = workflow.split(/^  draft:\r?$/m);

test("release credentials are isolated from dependency and repository execution", () => {
  assert.ok(prepare);
  assert.ok(draft, "draft creation needs a separate hosted job");
  assert.doesNotMatch(prepare, /contents: write|GH_TOKEN|gh release create/);
  assert.match(prepare, /contents: read/);
  assert.match(prepare, /npm ci/);
  assert.match(draft, /needs: prepare/);
  assert.match(draft, /runs-on: ubuntu-latest/);
  assert.match(draft, /contents: write/);
  const actions = [...draft.matchAll(/uses: ([^\s]+)/g)];
  assert.equal(actions.length, 1);
  assert.match(actions[0]![1]!, /^actions\/download-artifact@[a-f0-9]{40}$/);
  assert.doesNotMatch(
    draft,
    /\b(?:npm|npx|node|source|eval)\b|GITHUB_(?:PATH|ENV)|github-token:/,
  );
  assert.match(draft, /RELEASE_SHA: \$\{\{ inputs\.commit \}\}/);
  assert.match(draft, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(draft, /--repo "\$GITHUB_REPOSITORY"/);
  assert.match(draft, /--target "\$RELEASE_SHA" --draft --prerelease/);
});

test("release handoff contains only the packaged assets and notes", () => {
  assert.ok(prepare);
  assert.ok(draft);
  assert.match(
    prepare,
    /artifact-id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/,
  );
  const paths = prepare.match(
    /          path: \|\r?\n((?:            .+\r?\n)+)/,
  );
  assert.ok(paths?.[1]);
  assert.deepEqual(
    paths[1]
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim()),
    [
      "artifacts/workspace-mcp-${{ inputs.version }}.vsix",
      "artifacts/workspace-mcp-${{ inputs.version }}.vsix.sha256",
      "artifacts/release-notes.md",
    ],
  );
  assert.match(
    draft,
    /artifact-ids: \$\{\{ needs\.prepare\.outputs\.artifact-id \}\}/,
  );
  assert.match(draft, /path: artifacts/);
  assert.match(draft, /--notes-file artifacts\/release-notes\.md/);
});
