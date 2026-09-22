import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as vscode from "vscode";

interface Connection {
  args: string[];
  env: Record<string, string>;
}
interface Saved {
  connection: Connection;
  extensionPath: string;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function deadline<T>(operation: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Packaged test timed out")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectionDetails(): Promise<Connection> {
  // The command and editor-state events cross different RPC paths. Observe the
  // generated document before invoking the command instead of sampling the
  // active editor immediately after the command promise resolves.
  let opened!: (document: vscode.TextDocument) => void;
  const generated = new Promise<vscode.TextDocument>((resolve) => {
    opened = resolve;
  });
  const subscription = vscode.workspace.onDidOpenTextDocument((document) => {
    if (
      document.isUntitled &&
      document.getText().startsWith("[mcp_servers.workspace_mcp]")
    )
      opened(document);
  });
  const command = vscode.commands.executeCommand("workspaceMcp.connection");
  const timer = setInterval(() => {
    void vscode.commands.executeCommand(
      "workbench.action.acceptSelectedQuickOpenItem",
    );
  }, 100);
  let document: vscode.TextDocument;
  try {
    [, document] = await deadline(Promise.all([command, generated]));
  } finally {
    clearInterval(timer);
    subscription.dispose();
  }
  const entries = new Map(
    document
      .getText()
      .split("\n")
      .filter((line) => line.includes(" = "))
      .map((line) => {
        const separator = line.indexOf(" = ");
        return [
          line.slice(0, separator),
          JSON.parse(line.slice(separator + 3)),
        ] as const;
      }),
  );
  assert.equal(entries.get("command"), "node");
  const connection = {
    args: entries.get("args") as string[],
    env: Object.fromEntries(
      [
        "WORKSPACE_MCP_URL",
        "WORKSPACE_MCP_TOKEN",
        "WORKSPACE_MCP_CERTIFICATE",
      ].map((key) => [key, entries.get(key) as string]),
    ),
  };
  assert.equal(connection.args.length, 1);
  assert.ok(
    Object.values(connection.env).every(
      (value) => typeof value === "string" && value.length > 0,
    ),
  );
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor",
  );
  return connection;
}

async function connect(connection: Connection): Promise<Client> {
  const client = new Client({ name: "packaged-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.env.WORKSPACE_MCP_TEST_NODE!,
    args: connection.args,
    env: connection.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  try {
    await deadline(client.connect(transport));
    assert.equal(
      stderr.includes("synthetic-predecessor-adapter"),
      process.env.WORKSPACE_MCP_TEST_PHASE === "install",
      "The saved launcher must execute the current payload, not a previously installed adapter",
    );
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

async function readThroughProtocol(client: Client): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root);
  const roots = await client.callTool({
    name: "workspace_roots",
    arguments: {},
  });
  assert.equal(roots.isError, undefined);
  assert.ok(
    (roots.structuredContent as { result: Array<{ uri: string }> }).result.some(
      (item) => item.uri === root.toString(),
    ),
  );
  const file = vscode.Uri.joinPath(root, "smoke.txt");
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  assert.equal(
    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(0, 0, document.lineCount, 0),
        "unsaved packaged buffer\n",
      ),
    ),
    true,
  );
  const read = await client.callTool({
    name: "read_document",
    arguments: { uri: file.toString() },
  });
  assert.equal(read.isError, undefined);
  const result = (
    read.structuredContent as {
      result: {
        text: string;
        dirty: boolean;
        version: number;
      };
    }
  ).result;
  assert.equal(result.text, "unsaved packaged buffer\n");
  assert.equal(result.dirty, true);
  assert.equal(result.version, document.version);
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(file)).toString(),
    "packaged disk fixture\n",
  );
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor",
  );
}

async function requireListener(): Promise<void> {
  const port = vscode.workspace
    .getConfiguration("workspaceMcp")
    .get<number>("port")!;
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await deadline(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", () =>
          reject(new Error("Start completed without a listening bridge")),
        );
      }),
    );
  } finally {
    socket.destroy();
  }
}

export async function run(): Promise<void> {
  const phase = process.env.WORKSPACE_MCP_TEST_PHASE!;
  const statePath = process.env.WORKSPACE_MCP_TEST_STATE!;
  const extension = vscode.extensions.getExtension(
    "hendrik-101.vscode-workspace-mcp",
  );
  assert.ok(extension, "The product VSIX must be installed");
  assert.ok(
    within(process.env.WORKSPACE_MCP_TEST_EXTENSIONS!, extension.extensionPath),
  );
  assert.equal(
    extension.packageJSON.version,
    process.env.WORKSPACE_MCP_TEST_VERSION,
  );
  await extension.activate();
  let client: Client | undefined;
  try {
    await deadline(vscode.commands.executeCommand("workspaceMcp.start"));
    await requireListener();
    console.log(
      `Packaged VSIX ${phase}: bridge listening; requesting generated configuration`,
    );
    const current = await connectionDetails();
    let saved: Saved;
    if (phase === "install") {
      saved = { connection: current, extensionPath: extension.extensionPath };
      await writeFile(statePath, JSON.stringify(saved), { mode: 0o600 });
    } else {
      saved = JSON.parse(await readFile(statePath, "utf8")) as Saved;
      // Boolean comparisons keep tokens/certificates out of failed assertions.
      assert.ok(
        JSON.stringify(saved.connection) === JSON.stringify(current),
        "Saved client configuration must remain identical across installer operations",
      );
      assert.notEqual(
        extension.extensionPath,
        saved.extensionPath,
        "Upgrade must activate the newly installed extension directory",
      );
    }
    assert.ok(
      !within(process.env.WORKSPACE_MCP_TEST_EXTENSIONS!, current.args[0]!),
      "Stable adapter must survive extension-directory replacement",
    );
    const adapterDirectory = dirname(current.args[0]!);
    const markers = (
      await vscode.workspace.fs.readDirectory(vscode.Uri.file(adapterDirectory))
    )
      .filter(([name]) => name.endsWith(".ready"))
      .map(([name]) => name.slice(0, -6))
      .sort();
    assert.ok(markers.length > 0);
    const installedPayload = await readFile(
      join(extension.extensionPath, "dist/stdio.cjs"),
    );
    const selectedPayload = await readFile(
      join(adapterDirectory, markers.at(-1)!, "stdio.cjs"),
    );
    assert.ok(
      installedPayload.equals(selectedPayload),
      "Stable launcher must select the installed VSIX payload",
    );
    if (phase !== "install") {
      const oldPayload = await readFile(
        join(adapterDirectory, markers[0]!, "stdio.cjs"),
      );
      assert.ok(
        !oldPayload.equals(selectedPayload),
        "Upgrade must replace the synthetic predecessor payload",
      );
    }
    client = await connect(saved.connection);
    await readThroughProtocol(client);
    await deadline(vscode.commands.executeCommand("workspaceMcp.stop"));
    try {
      const response = await deadline(
        client.callTool({ name: "workspace_roots", arguments: {} }),
      );
      assert.equal(
        response.isError,
        true,
        "Stopped bridge must refuse requests",
      );
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.ok(error instanceof Error);
      assert.notEqual(
        error.message,
        "Packaged test timed out",
        "Stop must fail promptly rather than leave a request hanging",
      );
    }
    await client.close();
    client = undefined;
    await deadline(vscode.commands.executeCommand("workspaceMcp.start"));
    client = await connect(saved.connection);
    await readThroughProtocol(client);
    console.log(
      `Packaged VSIX ${phase}: installed extension, stdio roots/live read, stop/restart, stable configuration passed`,
    );
  } finally {
    await client?.close();
    await vscode.commands.executeCommand("workspaceMcp.stop");
  }
}
