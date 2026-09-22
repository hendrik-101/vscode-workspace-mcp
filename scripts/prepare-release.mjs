import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

try {
  const version = process.argv[2];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
    throw new Error("version must be numeric major.minor.patch");
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  if (
    [manifest.version, lock.version, lock.packages?.[""]?.version].some(
      (value) => value !== version,
    )
  ) {
    throw new Error("requested, manifest and lockfile versions must match");
  }
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const entries = [
    ...changelog.matchAll(
      /^## (\d+\.\d+\.\d+)(?:[^\S\n].*)?\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm,
    ),
  ];
  const entry = entries.filter((match) => match[1] === version);
  if (entry.length !== 1 || !/^[-*] \S/m.test(entry[0][2])) {
    throw new Error(
      "changelog must contain one nonempty entry for this version",
    );
  }
  const {
    RELEASE_SHA: sha,
    ACCEPTANCE_EVIDENCE: acceptance,
    SECURITY_EVIDENCE: security,
  } = process.env;
  if (
    !/^[a-f0-9]{40}$/.test(sha ?? "") ||
    !acceptance?.trim() ||
    !security?.trim()
  ) {
    throw new Error(
      "full revision, SAP/client acceptance and Codex Security scan evidence are required",
    );
  }
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/release-notes.md",
    `# Workspace MCP ${version} preview\n\nCommit: ${sha}\n\n${entry[0][2].trim()}\n\n## Validation evidence\n\n- SAP/client acceptance: ${acceptance.trim()}\n- Codex Security repository scan: ${security.trim()}\n\nInstall the attached VSIX with **Extensions: Install from VSIX**. Verify its SHA256 against the attached checksum file. This is a preview, not a Marketplace publication.\n`,
  );
} catch (error) {
  console.error(`Release validation: ${error.message}`);
  process.exitCode = 1;
}
