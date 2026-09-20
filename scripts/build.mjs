import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

await mkdir("artifacts", { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["vscode"],
  legalComments: "eof",
};
const result = await build({
  ...common,
  entryPoints: { extension: "src/extension.ts", stdio: "src/stdio-main.ts" },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  metafile: true,
});
await writeFile("artifacts/bundle-meta.json", JSON.stringify(result.metafile));

// Carry upstream license texts with the bundled code, including transitive code.
const packages = new Set(
  Object.keys(result.metafile.inputs)
    .map((input) => input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1])
    .filter(Boolean),
);
const notices = ["Third-party notices for the Workspace MCP extension bundle."];
for (const name of [...packages].sort()) {
  const directory = `node_modules/${name}`;
  const manifest = JSON.parse(
    await readFile(`${directory}/package.json`, "utf8"),
  );
  const licenses = (await readdir(directory))
    .filter((file) => /^(license|copying|notice)(\.|$)/i.test(file))
    .sort();
  if (licenses.length === 0) throw new Error(`Missing license text: ${name}`);
  notices.push(`\n${name}@${manifest.version} (${manifest.license})\n`);
  for (const file of licenses) {
    notices.push(await readFile(`${directory}/${file}`, "utf8"));
  }
}
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n"));
if (process.argv.includes("--tests")) {
  await build({
    ...common,
    entryPoints: ["test/vscode/index.ts"],
    outfile: "dist/test/vscode.cjs",
  });
}
