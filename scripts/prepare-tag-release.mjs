import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const tag = process.argv[2];
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? "")) {
    throw new Error("tag must be v followed by numeric major.minor.patch");
  }
  const ref = `refs/tags/${tag}`;
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("cat-file", "-t", ref) !== "tag")
    throw new Error("an annotated release tag is required");
  const sha = git("rev-parse", `${ref}^{commit}`);
  if (git("rev-parse", "HEAD") !== sha)
    throw new Error("checkout must match the tagged commit");
  git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  const annotation = git("for-each-ref", "--format=%(contents)", ref);
  const field = (name) => {
    const matches = [
      ...annotation.matchAll(new RegExp(`^${name}: ([^\\r\\n]+)$`, "gm")),
    ];
    if (matches.length !== 1 || !matches[0][1].trim())
      throw new Error(`tag requires exactly one ${name} field`);
    return matches[0][1].trim();
  };
  const channel = field("Channel");
  if (!["preview", "stable"].includes(channel))
    throw new Error("Channel must be preview or stable");
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  if (manifest.publisher !== "hendrik101")
    throw new Error("publisher must be hendrik101");
  if (channel === "stable" && manifest.preview === true)
    throw new Error("stable releases must clear the manifest preview flag");
  const version = tag.slice(1);
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./prepare-release.mjs", import.meta.url)),
      version,
      channel,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RELEASE_SHA: sha,
        ACCEPTANCE_EVIDENCE: field("Acceptance"),
        SECURITY_EVIDENCE: field("Security"),
      },
    },
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\nchannel=${channel}\nsha=${sha}\n`,
    );
} catch {
  // Tag annotations and backend evidence must not be echoed on failure.
  console.error(
    "Release validation: require an annotated numeric tag, one valid Channel/Acceptance/Security field, matching publisher/version/changelog, and a checked-out commit on main",
  );
  process.exitCode = 1;
}
