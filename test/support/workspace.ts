import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import * as contracts from "../../src/types";
import type { WorkspaceService } from "../../src/workspace";

const code = transformSync(readFileSync("src/workspace.ts", "utf8"), {
  loader: "ts",
  format: "cjs",
}).code;

/** Each fixture gets a fresh VM, with only its explicit globals and imports. */
export function loadWorkspace(
  vscode: unknown,
  globals: Record<string, unknown> = {},
  crypto: object = { randomUUID },
): typeof WorkspaceService {
  const module = {
    exports: {} as { WorkspaceService: typeof WorkspaceService },
  };
  runInNewContext(code, {
    ...globals,
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === "vscode") return vscode;
      if (id === "node:buffer") return { Buffer };
      if (id === "node:crypto") return crypto;
      if (id === "./types") return contracts;
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  return module.exports.WorkspaceService;
}
