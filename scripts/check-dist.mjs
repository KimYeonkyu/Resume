import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expectedPublicFiles } from "./public-build-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(repositoryRoot, "dist");
const manifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "config", "portfolio-manifest.json"), "utf8"),
);

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) throw new Error("Build output must not contain symbolic links");
    if (info.isDirectory()) results.push(...(await walk(absolutePath)));
    else if (info.isFile()) results.push(absolutePath);
    else throw new Error("Build output contains a non-regular filesystem entry");
  }
  return results;
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function decodedVariants(value) {
  const variants = [value];
  for (let index = 0; index < 2; index += 1) {
    const decoded = variants.at(-1).replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encodedRun) => {
      try {
        return decodeURIComponent(encodedRun);
      } catch {
        return encodedRun;
      }
    });
    variants.push(decoded);
  }
  return variants;
}

function normalized(value) {
  return value.normalize("NFC").toLowerCase();
}

const outputFiles = await walk(distDirectory);
const outputRelativePaths = outputFiles.map((file) =>
  path.relative(distDirectory, file).split(path.sep).join("/"),
);
const outputRelativePathSet = new Set(outputRelativePaths);
const normalizedOutputPaths = outputRelativePaths.map(normalized);

for (const directory of manifest.deploymentExclusions.directories) {
  const prefix = `${normalized(directory)}/`;
  if (normalizedOutputPaths.some((file) => file === normalized(directory) || file.startsWith(prefix))) {
    throw new Error("A protected source directory was copied to the public build");
  }
}
for (const file of manifest.deploymentExclusions.files) {
  if (normalizedOutputPaths.includes(normalized(file))) {
    throw new Error("A protected source file was copied publicly");
  }
}

const protectedItems = manifest.projects.flatMap((project) =>
  project.items.filter((item) => project.protected === true || item.protected === true),
);
for (const item of protectedItems) {
  if (
    typeof item.sourcePath !== "string" ||
    typeof item.routeId !== "string" ||
    typeof item.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.sha256)
  ) {
    throw new Error("Protected manifest item is missing required self-hosted metadata");
  }
}
const protectedHashes = new Set(protectedItems.map((item) => item.sha256));
const publicBasenames = new Set(
  manifest.projects
    .flatMap((project) =>
      project.items.filter((item) => project.protected !== true && item.protected !== true),
    )
    .flatMap((item) => [item.sourcePath, item.posterPath].filter(Boolean))
    .map((sourcePath) => path.posix.basename(sourcePath).toLowerCase()),
);
const uniqueProtectedBasenames = protectedItems
  .map((item) => path.posix.basename(item.sourcePath))
  .filter((basename) => !publicBasenames.has(basename.toLowerCase()));
const forbiddenValues = new Set(
  protectedItems.flatMap((item) => [
    item.sourcePath,
    encodePath(item.sourcePath),
    item.routeId,
    item.sha256,
  ]),
);
for (const excludedFile of manifest.deploymentExclusions.files) {
  forbiddenValues.add(excludedFile);
  forbiddenValues.add(encodePath(excludedFile));
}
for (const basename of uniqueProtectedBasenames) {
  forbiddenValues.add(basename);
  forbiddenValues.add(encodeURIComponent(basename));
}

for (const outputFile of outputFiles) {
  const bytes = await readFile(outputFile);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (protectedHashes.has(digest)) {
    throw new Error("Public output contains protected media bytes");
  }
  const text = bytes.toString("utf8");
  const haystacks = decodedVariants(text).map(normalized);
  for (const forbidden of forbiddenValues) {
    const needle = normalized(forbidden);
    if (haystacks.some((haystack) => haystack.includes(needle))) {
      throw new Error("Public output exposes protected media metadata");
    }
  }
  for (const secretName of [
    "PORTFOLIO_PASSWORD_VERIFIER",
    "PORTFOLIO_PASSWORD_PEPPER",
    "SESSION_SECRET",
  ]) {
    const value = process.env[secretName];
    if (value && bytes.includes(Buffer.from(value))) {
      throw new Error("Public output contains a runtime secret");
    }
  }
}

const expectedPaths = expectedPublicFiles(manifest);
for (const outputPath of outputRelativePaths) {
  if (!expectedPaths.has(outputPath)) {
    throw new Error(`Public build contains an unexpected file: ${outputPath}`);
  }
}
for (const expectedPath of expectedPaths) {
  if (!outputRelativePathSet.has(expectedPath)) {
    throw new Error(`Public build is missing an expected file: ${expectedPath}`);
  }
}

console.log(`Verified the exact ${outputFiles.length}-file public build; protected media is excluded.`);
