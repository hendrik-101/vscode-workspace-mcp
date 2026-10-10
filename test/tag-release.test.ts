import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/prepare-tag-release.mjs");
function candidate(
  options: {
    message?: string;
    lightweight?: boolean;
    outsideMain?: boolean;
    version?: string;
    publisher?: string;
    preview?: boolean;
    tag?: string;
  } = {},
) {
  const cwd = mkdtempSync(`${tmpdir()}/workspace-mcp-tag-`);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  git("init", "-q");
  writeFileSync(
    resolve(cwd, "package.json"),
    JSON.stringify({
      version: options.version ?? "0.1.0",
      publisher: options.publisher ?? "hendrik101",
      preview: options.preview,
    }),
  );
  writeFileSync(
    resolve(cwd, "package-lock.json"),
    JSON.stringify({
      version: "0.1.0",
      packages: { "": { version: "0.1.0" } },
    }),
  );
  writeFileSync(
    resolve(cwd, "CHANGELOG.md"),
    "# Changelog\n\n## 0.1.0\n\n- Test release.\n",
  );
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  if (options.outsideMain) {
    writeFileSync(resolve(cwd, "other"), "new commit");
    git("add", ".");
    git("commit", "-qm", "outside main");
  }
  const sha = git("rev-parse", "HEAD");
  const tag = options.tag ?? "v0.1.0";
  const message =
    options.message ??
    "Workspace MCP\n\nChannel: preview\nAcceptance: redacted acceptance reference\nSecurity: redacted scan reference";
  if (options.lightweight) git("tag", tag);
  else git("tag", "-a", tag, "-m", message);
  const result = spawnSync(process.execPath, [script, tag], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: resolve(cwd, "outputs") },
  });
  return { cwd, sha, result };
}

test("annotated tag produces release metadata and notes for its exact main commit", () => {
  const { cwd, sha, result } = candidate();
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(resolve(cwd, "outputs"), "utf8"),
      `version=0.1.0\nchannel=preview\nsha=${sha}\n`,
    );
    const notes = readFileSync(
      resolve(cwd, "artifacts/release-notes.md"),
      "utf8",
    );
    assert.ok(notes.includes(sha));
    assert.match(notes, /redacted acceptance reference/);
    assert.match(notes, /redacted scan reference/);
    assert.match(notes, /Marketplace publication is a separate workflow job/);
    assert.doesNotMatch(notes, /draft-only|not a Marketplace publication/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stable channel produces release notes without claiming a preview", () => {
  const { cwd, result } = candidate({
    message: "Channel: stable\nAcceptance: acceptance\nSecurity: scan",
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      readFileSync(resolve(cwd, "artifacts/release-notes.md"), "utf8"),
      /preview|not a Marketplace publication/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [name, options] of Object.entries({
  "lightweight tag": { lightweight: true },
  "commit outside main": { outsideMain: true },
  "mismatched version": { version: "0.2.0" },
  "wrong publisher": { publisher: "hendrik-101" },
  "stable tag with preview manifest": {
    preview: true,
    message: "Channel: stable\nAcceptance: acceptance\nSecurity: scan",
  },
  "non-numeric tag": { tag: "v0.1.0-beta" },
  "missing evidence": { message: "Channel: preview\nAcceptance: acceptance" },
  "ambiguous channel": {
    message:
      "Channel: preview\nChannel: stable\nAcceptance: acceptance\nSecurity: scan",
  },
  "invalid channel": {
    message: "Channel: nightly\nAcceptance: acceptance\nSecurity: scan",
  },
})) {
  test(`tag release rejects ${name}`, () => {
    const { cwd, result } = candidate(options);
    try {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Release validation:/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
