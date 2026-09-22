import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "workspace-mcp-vscode-"));
const packaged = process.argv.includes("--packaged");
const withAdt = process.argv.includes("--adt");
const adtVersion = "1.1.2";

try {
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    throw new Error(
      "VS Code requires a display. On headless Linux, run xvfb-run -a npm run test:vscode.",
    );
  }
  execFileSync(
    process.execPath,
    [join(project, "scripts/build.mjs"), "--tests"],
    {
      cwd: project,
      stdio: "inherit",
    },
  );
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_VERSION || "1.137.0",
    cachePath: join(project, ".vscode-test"),
    timeout: 30_000,
  });
  const workspace = join(temporary, "workspace");
  const workspaceFile = join(temporary, "integration.code-workspace");
  const userData = join(temporary, "user-data");
  const extensions = join(temporary, "extensions");
  await mkdir(workspace);
  await writeFile(join(workspace, "smoke.txt"), "packaged disk fixture\n");
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
      "workspaceMcp.writePolicy": "deny",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "files.autoSave": "off",
      "files.hotExit": "off",
      "telemetry.telemetryLevel": "off",
      "workbench.startupEditor": "none",
      "update.mode": "none",
    }),
  );
  if (withAdt) {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(
      vscodeExecutablePath,
      { reuseMachineInstall: true },
    );
    execFileSync(
      cli,
      [
        ...args,
        "--no-sandbox",
        "--disable-telemetry",
        "--disable-crash-reporter",
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
        "--install-extension",
        `SAPSE.adt-vscode@${adtVersion}`,
      ],
      {
        stdio: "inherit",
        timeout: 180_000,
        shell: process.platform === "win32",
      },
    );
  }
  if (packaged) {
    const { testPackaged } = await import("./test-packaged.mjs");
    await testPackaged({
      project,
      temporary,
      vscodeExecutablePath,
      workspaceFile,
      userData,
      extensions,
    });
  } else
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: project,
      extensionTestsPath: join(project, "dist/test/vscode.cjs"),
      extensionTestsEnv: {
        WORKSPACE_MCP_ADT_VERSION: withAdt ? adtVersion : "",
      },
      launchArgs: [
        workspaceFile,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        ...(withAdt ? [] : ["--disable-extensions"]),
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
      ],
    });
} catch (error) {
  console.error(
    "VS Code integration tests did not complete:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
