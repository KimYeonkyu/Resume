import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "config", "portfolio-manifest.json"), "utf8"),
);
const wranglerConfiguration = JSON.parse(
  await readFile(path.join(repositoryRoot, "wrangler.jsonc"), "utf8"),
);
const protectedItems = manifest.projects
  .filter((project) => project.protected)
  .flatMap((project) => project.items);
const bucket = wranglerConfiguration.r2_buckets?.find(
  (binding) => binding.binding === "PROTECTED_MEDIA",
)?.bucket_name;
const execute = process.argv.slice(2).includes("--execute");

if (process.argv.slice(2).some((argument) => argument !== "--execute")) {
  throw new Error("Unknown argument. Use no flag for a plan or --execute to upload.");
}
if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) {
  throw new Error("Wrangler must define a valid private R2 bucket name");
}

for (const item of protectedItems) {
  if (!/^[a-z0-9][a-z0-9._/-]{1,255}$/u.test(item.r2Key) || item.r2Key.includes("..")) {
    throw new Error("Protected manifest contains an invalid R2 object key");
  }
  const source = path.resolve(repositoryRoot, item.sourcePath);
  if (!source.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error("Protected source path escapes the repository");
  }
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Protected upload source must be a regular file");
  }
  if (!(await realpath(source)).startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error("Protected upload source resolves outside the repository");
  }
}

if (!execute) {
  console.log(`Plan: ${protectedItems.length} protected objects -> private R2 bucket ${bucket}.`);
  console.log("No uploads performed. Re-run with --execute only after completing the security blocker.");
  process.exit(0);
}

const wranglerExecutable = path.join(repositoryRoot, "node_modules", ".bin", "wrangler");
for (const item of protectedItems) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      wranglerExecutable,
      [
        "r2",
        "object",
        "put",
        `${bucket}/${item.r2Key}`,
        "--file",
        path.join(repositoryRoot, item.sourcePath),
        "--content-type",
        item.contentType,
        "--cache-control",
        "private, no-store",
        "--remote",
      ],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Wrangler failed while uploading protected media"));
    });
  });
}
console.log(`Uploaded ${protectedItems.length} protected objects to the configured private R2 bucket.`);
