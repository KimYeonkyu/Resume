import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { rootPublicFiles } from "./public-build-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(repositoryRoot, "dist");
const execFileAsync = promisify(execFile);
const manifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "config", "portfolio-manifest.json"), "utf8"),
);

function resolveInside(base, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new Error("Build allowlist contains an invalid path");
  }
  const resolved = path.resolve(base, relativePath);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Build allowlist path escapes the repository");
  }
  return resolved;
}

async function copyAllowlistedFile(relativePath) {
  const source = resolveInside(repositoryRoot, relativePath);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("Build allowlist entries must be regular files");
  }
  const realSource = await realpath(source);
  if (!realSource.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error("Build source resolves outside the repository");
  }

  const destination = resolveInside(distDirectory, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

if (path.dirname(distDirectory) !== repositoryRoot || path.basename(distDirectory) !== "dist") {
  throw new Error("Refusing to clean an unexpected build directory");
}
await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

const publicFiles = new Set(rootPublicFiles);
for (const project of manifest.projects) {
  for (const item of project.items) {
    if (project.protected === true || item.protected === true) continue;
    publicFiles.add(item.sourcePath);
    if (item.posterPath) publicFiles.add(item.posterPath);
  }
}
for (const relativePath of [...publicFiles].sort()) await copyAllowlistedFile(relativePath);

await execFileAsync(process.execPath, [
  path.join(repositoryRoot, "node_modules", "tailwindcss", "lib", "cli.js"),
  "--config",
  path.join(repositoryRoot, "tailwind.config.cjs"),
  "--input",
  path.join(repositoryRoot, "styles", "resume.css"),
  "--output",
  path.join(distDirectory, "resume.css"),
  "--minify",
], { cwd: repositoryRoot });

await copyAllowlistedFile("static-assets/.assetsignore");
await mkdir(path.join(distDirectory), { recursive: true });
await copyFile(
  path.join(distDirectory, "static-assets", ".assetsignore"),
  path.join(distDirectory, ".assetsignore"),
);
await rm(path.join(distDirectory, "static-assets"), { recursive: true });

console.log(`Built ${publicFiles.size + 2} explicitly allowlisted public assets.`);
