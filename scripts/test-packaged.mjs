import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { createVSIX, listFiles, PackageManager } from "@vscode/vsce";
import {
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

/** Install actual archives; only the empty test harness is a development extension. */
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
  // Temporary diagnostic on the synthetic predecessor only. Never log error
  // messages, stack text, credentials or configuration values other than port.
  const entry = join(predecessor, "dist/extension.cjs");
  const source = await readFile(entry, "utf8");
  const diagnostic = (label, error) => `
    console.error(${JSON.stringify(label)}, {
      name: ["Error", "TypeError", "RangeError", "FileSystemError"].includes(${error}?.name) ? ${error}.name : "other",
      code: typeof ${error}?.code === "string" && (/^[A-Z][A-Z0-9_]{0,63}$/.test(${error}.code) || ["FileNotFound", "FileExists", "FileNotADirectory", "FileIsADirectory", "NoPermissions", "Unavailable", "Unknown"].includes(${error}.code)) ? ${error}.code : "none",
      category: ["Workspace MCP adapter", "Workspace MCP port", "Stored Workspace MCP token", "Stored Workspace MCP server identity"].find(prefix => typeof ${error}?.message === "string" && ${error}.message.startsWith(prefix)) || "other",
      offsets: typeof ${error}?.stack === "string" ? ${error}.stack.split("\\n").slice(1).map(frame => frame.match(/:(\\d+):(\\d+)\\)?$/)?.slice(1)).filter(Boolean) : []
    });`;
  let instrumented = source;
  for (const [boundary, label] of [
    [/const report = \((\w+)\) => \{/, "Packaged predecessor startup failure"],
    [
      /installAdapter\(context, checkCurrent\)\.catch\(\s*\((\w+)\) => \{/,
      "Packaged predecessor adapter failure",
    ],
  ]) {
    if (!boundary.test(instrumented))
      throw new Error("Missing predecessor diagnostic boundary");
    instrumented = instrumented.replace(
      boundary,
      (match, error) => match + diagnostic(label, error),
    );
  }
  await writeFile(entry, instrumented);
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
      main: "empty.cjs",
      activationEvents: [],
    }),
  );
  await writeFile(join(harness, "empty.cjs"), "exports.activate = () => {};\n");
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
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: harness,
      extensionTestsPath: suite,
      extensionTestsEnv: {
        WORKSPACE_MCP_TEST_PHASE: phase,
        WORKSPACE_MCP_TEST_VERSION: version,
        WORKSPACE_MCP_TEST_STATE: join(temporary, "private-connection.json"),
        WORKSPACE_MCP_TEST_EXTENSIONS: extensions,
        WORKSPACE_MCP_TEST_NODE: process.execPath,
      },
      launchArgs: [
        workspaceFile,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--password-store=basic",
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
      ],
    });
  }
}
