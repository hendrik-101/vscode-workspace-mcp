import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "workspace-mcp-vscode-"));

try {
  execFileSync(
    process.execPath,
    [join(project, "scripts/build.mjs"), "--tests"],
    {
      cwd: project,
      stdio: "inherit",
    },
  );
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_VERSION || "1.102.3",
    cachePath: join(project, ".vscode-test"),
    timeout: 30_000,
  });
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    throw new Error(
      "VS Code requires a display. On headless Linux, run xvfb-run -a npm run test:vscode.",
    );
  }
  const workspace = join(temporary, "workspace");
  const workspaceFile = join(temporary, "integration.code-workspace");
  const userData = join(temporary, "user-data");
  await mkdir(workspace);
  // Begin in multi-root mode: converting a single folder during a test restarts
  // the extension host and cancels the running suite.
  await writeFile(
    workspaceFile,
    JSON.stringify({ folders: [{ path: workspace }] }),
  );
  await mkdir(join(userData, "User"), { recursive: true });
  await writeFile(
    join(userData, "User/settings.json"),
    JSON.stringify({
      "files.autoSave": "off",
      "files.hotExit": "off",
      "telemetry.telemetryLevel": "off",
      "workbench.startupEditor": "none",
      "update.mode": "none",
    }),
  );
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: project,
    extensionTestsPath: join(project, "dist/test/vscode.cjs"),
    launchArgs: [
      workspaceFile,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-extensions",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(temporary, "extensions")}`,
    ],
  });
} catch (error) {
  console.error(
    "VS Code integration tests did not complete:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
