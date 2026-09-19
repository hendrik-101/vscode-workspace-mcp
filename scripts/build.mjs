import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("artifacts", { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  legalComments: "eof",
};
await build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  metafile: true,
}).then(async (result) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    "artifacts/bundle-meta.json",
    JSON.stringify(result.metafile),
  );
});
if (process.argv.includes("--tests")) {
  await build({
    ...common,
    entryPoints: ["test/vscode/index.ts"],
    outfile: "dist/test/vscode.cjs",
  });
}
