import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicMediaVersions,
  serializePublicMediaVersions,
  serializePublicPortfolioManifest,
  verifyGeneratedArtifact,
  writeGeneratedArtifacts,
} from "./public-manifest.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuration = JSON.parse(
  await readFile(path.join(repositoryRoot, "config", "portfolio-manifest.json"), "utf8"),
);
const mediaVersions = await createPublicMediaVersions(configuration, repositoryRoot);
const artifacts = [
  {
    relativePath: "public-media-versions.json",
    content: serializePublicMediaVersions(mediaVersions),
  },
  {
    relativePath: "public-portfolio-manifest.json",
    content: serializePublicPortfolioManifest(configuration, mediaVersions),
  },
];

if (process.argv.includes("--check")) {
  for (const artifact of artifacts) {
    const artifactPath = path.join(repositoryRoot, artifact.relativePath);
    try {
      await verifyGeneratedArtifact(repositoryRoot, artifact);
    } catch (error) {
      throw new Error(
        `${path.basename(artifactPath)} is stale; run npm run manifest:public`,
        { cause: error },
      );
    }
  }
  console.log("Verified the committed public media versions and GitHub Pages manifest.");
} else {
  await writeGeneratedArtifacts(repositoryRoot, artifacts);
  console.log("Generated public-media-versions.json and public-portfolio-manifest.json.");
}
