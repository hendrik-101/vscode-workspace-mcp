import { execFileSync, spawn } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { createVSIX, listFiles, PackageManager } from "@vscode/vsce";
import { resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";

/** Install actual archives; only the test harness is a development extension. */
export async function testPackaged({
  project,
  temporary,
  vscodeExecutablePath,
  workspaceFile,
  userData,
  extensions,
}) {
  const manifest = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  const current = join(temporary, "current.vsix");
  await createVSIX({ cwd: project, packagePath: current, dependencies: false });

  // There is no released predecessor yet. Use a clearly synthetic lower version
  // with different adapter bytes to exercise a real VS Code installer upgrade.
  const predecessor = join(temporary, "predecessor");
  await mkdir(predecessor);
  const packagedFiles = await listFiles({
    cwd: project,
    packageManager: PackageManager.None,
  });
  for (const path of [...packagedFiles, ".vscodeignore"]) {
    const destination = join(predecessor, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(project, path), destination);
  }
  await writeFile(
    join(predecessor, "package.json"),
    JSON.stringify({ ...manifest, version: "0.0.0" }),
  );
  await appendFile(
    join(predecessor, "dist/stdio.cjs"),
    '\nprocess.stderr.write("synthetic-predecessor-adapter\\n");\n',
  );
  const previous = join(temporary, "previous.vsix");
  await createVSIX({
    cwd: predecessor,
    packagePath: previous,
    dependencies: false,
  });

  const harness = join(temporary, "harness");
  await mkdir(harness);
  await writeFile(
    join(harness, "package.json"),
    JSON.stringify({
      name: "workspace-mcp-packaged-test",
      publisher: "test-only",
      version: "0.0.0",
      engines: { vscode: manifest.engines.vscode },
      main: "harness.cjs",
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(
    join(harness, "harness.cjs"),
    `const vscode = require("vscode");
const { writeFile } = require("node:fs/promises");
exports.activate = context => {
  setImmediate(async () => {
    let passed = false;
    try {
      await require("./suite.cjs").run();
      passed = true;
    } catch (error) {
      console.error("Packaged fixture failed", {
        name: ["Error", "AssertionError", "TypeError"].includes(error?.name) ? error.name : "other",
        code: typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "none",
        offsets: typeof error?.stack === "string" ? error.stack.split("\\n").slice(1).map(frame => frame.match(/:(\\d+):(\\d+)\\)?$/)?.slice(1)).filter(Boolean) : []
      });
    } finally {
      try {
        await writeFile(process.env.WORKSPACE_MCP_TEST_RESULT, JSON.stringify({ phase: process.env.WORKSPACE_MCP_TEST_PHASE, passed }));
      } finally {
        await vscode.commands.executeCommand("workbench.action.quit");
      }
    }
  });
  return { storageScheme: context.globalStorageUri.scheme };
};
`,
  );
  const suite = join(harness, "suite.cjs");
  await build({
    entryPoints: [join(project, "test/vscode/packaged.ts")],
    outfile: suite,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["vscode"],
  });

  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(
    vscodeExecutablePath,
    { reuseMachineInstall: true },
  );
  const install = (...args) => {
    const allArgs = [
      ...cliArgs,
      "--no-sandbox",
      "--disable-telemetry",
      "--disable-crash-reporter",
      `--shared-data-dir=${join(temporary, "shared-data")}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      ...args,
    ];
    // Windows' .cmd launcher requires a shell; quote paths containing spaces.
    execFileSync(
      process.platform === "win32" ? `"${cli}"` : cli,
      process.platform === "win32" ? allArgs.map((arg) => `"${arg}"`) : allArgs,
      {
        stdio: "inherit",
        timeout: 180_000,
        shell: process.platform === "win32",
      },
    );
  };
  for (const [phase, vsix, version] of [
    ["install", previous, "0.0.0"],
    ["upgrade", current, manifest.version],
    ["reinstall", current, manifest.version],
  ]) {
    if (phase === "reinstall")
      install(
        "--uninstall-extension",
        `${manifest.publisher}.${manifest.name}`,
      );
    install("--install-extension", vsix, "--force");
    const resultPath = join(temporary, `${phase}-result.json`);
    // VS Code deliberately uses in-memory storage with --extensionTestsPath.
    // A normal host and graceful quit exercise real SecretStorage persistence.
    const args = [
      workspaceFile,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--password-store=basic",
      "--disable-telemetry",
      "--disable-crash-reporter",
      `--extensionDevelopmentPath=${harness}`,
      `--shared-data-dir=${join(temporary, "shared-data")}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
    ];
    await new Promise((resolve, reject) => {
      const child = spawn(vscodeExecutablePath, args, {
        stdio: "inherit",
        timeout: 180_000,
        env: {
          ...process.env,
          WORKSPACE_MCP_TEST_PHASE: phase,
          WORKSPACE_MCP_TEST_VERSION: version,
          WORKSPACE_MCP_TEST_STATE: join(temporary, "private-connection.json"),
          WORKSPACE_MCP_TEST_EXTENSIONS: extensions,
          WORKSPACE_MCP_TEST_NODE: process.execPath,
          WORKSPACE_MCP_TEST_RESULT: resultPath,
        },
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0 && !signal) resolve();
        else
          reject(
            new Error(
              `Packaged ${phase} host exited with code ${code}, signal ${signal}`,
            ),
          );
      });
    });
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (result.phase !== phase || result.passed !== true)
      throw new Error(`Packaged ${phase} fixture did not pass`);
  }
}
