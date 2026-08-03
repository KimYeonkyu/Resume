import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "server-dist");
const outputFile = path.join(outputDirectory, "server.mjs");
if (path.dirname(outputDirectory) !== repositoryRoot || path.basename(outputDirectory) !== "server-dist") {
  throw new Error("Refusing to clean an unexpected server bundle directory");
}
await rm(outputDirectory, { recursive: true, force: true });

await build({
  banner: { js: "#!/usr/bin/env node" },
  bundle: true,
  entryPoints: [path.join(repositoryRoot, "src", "main.ts")],
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
  minify: false,
  outfile: outputFile,
  platform: "node",
  sourcemap: false,
  target: "node22",
  treeShaking: true,
});
await chmod(outputFile, 0o755);
console.log("Built production Node backend bundle: server-dist/server.mjs");
