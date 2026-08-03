import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serializePublicPortfolioManifest } from "./public-manifest.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuration = JSON.parse(
  await readFile(path.join(repositoryRoot, "config", "portfolio-manifest.json"), "utf8"),
);
const outputPath = path.join(repositoryRoot, "public-portfolio-manifest.json");
const expected = serializePublicPortfolioManifest(configuration);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    // Report the same actionable error for a missing or stale generated file.
  }
  if (current !== expected) {
    throw new Error("public-portfolio-manifest.json is stale; run npm run manifest:public");
  }
  console.log("Verified the committed public GitHub Pages manifest.");
} else {
  await writeFile(outputPath, expected, { mode: 0o644 });
  console.log("Generated public-portfolio-manifest.json.");
}
