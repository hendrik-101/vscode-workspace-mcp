import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/prepare-release.mjs");
function prepare(
  overrides: Record<string, string> = {},
  version = "0.1.0",
  evidence: Record<string, string> = {},
) {
  const cwd = mkdtempSync(`${tmpdir()}/workspace-mcp-release-`);
  const files = {
    "package.json": JSON.stringify({ version: "0.1.0" }),
    "package-lock.json": JSON.stringify({
      version: "0.1.0",
      packages: { "": { version: "0.1.0" } },
    }),
    "CHANGELOG.md":
      "# Changelog\n\n## 0.1.0 — initial preview\n\n- Live buffers.\n\n## 0.0.1\n\n- Older change.\n",
    ...overrides,
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(resolve(cwd, name), value);
  const result = spawnSync(process.execPath, [script, version], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_SHA: "a".repeat(40),
      ACCEPTANCE_EVIDENCE: "Acceptance issue #1",
      SECURITY_EVIDENCE: "Security scan #2",
      ...evidence,
    },
  });
  return { cwd, result };
}

test("release notes select only the matching changelog and include revision and evidence", () => {
  const { cwd, result } = prepare();
  try {
    assert.equal(result.status, 0, result.stderr);
    const notes = readFileSync(
      resolve(cwd, "artifacts/release-notes.md"),
      "utf8",
    );
    assert.match(notes, /Live buffers/);
    assert.doesNotMatch(notes, /Older change/);
    assert.match(notes, /a{40}/);
    assert.match(notes, /Acceptance issue #1/);
    assert.match(notes, /Security scan #2/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [name, files] of Object.entries<Record<string, string>>({
  "manifest version mismatch": { "package.json": '{"version":"0.2.0"}' },
  "lockfile version mismatch": {
    "package-lock.json":
      '{"version":"0.1.0","packages":{"":{"version":"0.2.0"}}}',
  },
  "missing changelog entry": {
    "CHANGELOG.md": "# Changelog\n\n## 0.2.0\n\n- Different release.\n",
  },
  "empty changelog entry": {
    "CHANGELOG.md": "# Changelog\n\n## 0.1.0\n\n## 0.0.1\n- Old.\n",
  },
})) {
  test(`release rejects ${name}`, () => {
    const { cwd, result } = prepare(files);
    try {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Release validation:/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const [name, version, evidence] of [
  ["prerelease suffix", "0.1.0-beta", {}],
  ["leading zero", "01.1.0", {}],
  ["missing acceptance", "0.1.0", { ACCEPTANCE_EVIDENCE: " " }],
  ["missing Security scan", "0.1.0", { SECURITY_EVIDENCE: "" }],
  ["abbreviated revision", "0.1.0", { RELEASE_SHA: "abcdef1" }],
] as [string, string, Record<string, string>][]) {
  test(`release rejects ${name}`, () => {
    const { cwd, result } = prepare({}, version, evidence);
    try {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Release validation:/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
