import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(repositoryRoot, "dist");
const manifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "config", "portfolio-manifest.json"), "utf8"),
);
const textExtensions = new Set([".css", ".html", ".js", ".json"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

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
    const decoded = variants
      .at(-1)
      .replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encodedRun) => {
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

const outputFiles = await walk(distDirectory);
const outputRelativePaths = new Set(
  outputFiles.map((file) => path.relative(distDirectory, file).split(path.sep).join("/")),
);

for (const directory of manifest.deploymentExclusions.directories) {
  if ([...outputRelativePaths].some((file) => file.startsWith(`${directory}/`))) {
    throw new Error("A protected source directory was copied to the public build");
  }
}
for (const file of manifest.deploymentExclusions.files) {
  if (outputRelativePaths.has(file)) throw new Error("A protected source file was copied publicly");
}

const protectedItems = manifest.projects
  .filter((project) => project.protected)
  .flatMap((project) => project.items);
const protectedSourcePaths = [
  ...protectedItems.map((item) => item.sourcePath),
  ...manifest.deploymentExclusions.files,
];
const protectedHashes = new Set();
for (const relativePath of protectedSourcePaths) {
  protectedHashes.add(sha256(await readFile(path.join(repositoryRoot, relativePath))));
}

for (const outputFile of outputFiles) {
  if (protectedHashes.has(sha256(await readFile(outputFile)))) {
    throw new Error("Public build contains bytes identical to protected source media");
  }
}

const publicBasenames = new Set(
  manifest.projects
    .filter((project) => !project.protected)
    .flatMap((project) => project.items)
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
    item.r2Key,
    item.routeId,
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
  if (!textExtensions.has(path.extname(outputFile).toLowerCase())) continue;
  const text = await readFile(outputFile, "utf8");
  const haystacks = decodedVariants(text).map((value) => value.normalize("NFC").toLowerCase());
  for (const forbidden of forbiddenValues) {
    const needle = forbidden.normalize("NFC").toLowerCase();
    if (haystacks.some((haystack) => haystack.includes(needle))) {
      throw new Error("Public text output exposes protected media metadata");
    }
  }
  for (const secretName of ["PORTFOLIO_PASSWORD_HASH", "SESSION_SECRET"]) {
    const value = process.env[secretName];
    if (value && text.includes(value)) throw new Error("Public output contains a runtime secret");
  }
}

for (const project of manifest.projects.filter((candidate) => !candidate.protected)) {
  for (const item of project.items) {
    if (!outputRelativePaths.has(item.sourcePath)) {
      throw new Error("A public portfolio item is missing from the build");
    }
    if (item.posterPath && !outputRelativePaths.has(item.posterPath)) {
      throw new Error("A public portfolio poster is missing from the build");
    }
  }
}

console.log(`Verified ${outputFiles.length} public build files; protected media is excluded.`);
