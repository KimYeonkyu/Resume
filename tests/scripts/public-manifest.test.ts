import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import configuration from "../../config/portfolio-manifest.json";
import generatedPublicMediaVersions from "../../public-media-versions.json";
import {
  createPublicMediaVersions,
  createPublicPortfolioManifest,
  validatePublicMediaRoot,
} from "../../scripts/public-manifest.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);

async function currentPublicMediaVersions(): Promise<Record<string, string>> {
  const sourcePaths = new Set<string>();
  for (const project of configuration.projects) {
    for (const item of project.items) {
      const selected = project.protected || ("protected" in item && item.protected === true);
      if (selected) continue;
      sourcePaths.add(item.sourcePath);
      if ("posterPath" in item) sourcePaths.add(item.posterPath);
    }
  }
  return Object.fromEntries(
    await Promise.all(
      [...sourcePaths].map(async (sourcePath) => [
        sourcePath,
        createHash("sha256")
          .update(await readFile(path.join(repositoryRoot, sourcePath)))
          .digest("hex"),
      ]),
    ),
  );
}

describe("static public portfolio manifest", () => {
  it("keeps public items usable while replacing every selected item with a safe placeholder", async () => {
    const versions = await currentPublicMediaVersions();
    const manifest = createPublicPortfolioManifest(configuration, versions);
    const warhaven = manifest.projects.find((project) => project.id === "warhaven");
    const mp = manifest.projects.find((project) => project.id === "project-mp");
    const dm = manifest.projects.find((project) => project.id === "project-dm");

    expect(warhaven?.items[10]).toMatchObject({ id: "warhaven-11", type: "image" });
    expect(warhaven?.items[11]).toMatchObject({ locked: true, type: "locked" });
    expect(warhaven?.items[20]).toMatchObject({ id: "warhaven-21", type: "image" });
    expect(warhaven?.items[21]).toMatchObject({ locked: true, type: "locked" });
    expect(warhaven?.items[22]).toMatchObject({ id: "warhaven-23", type: "image" });
    expect(mp?.items[0]).toMatchObject({ id: "project-mp-24", type: "image" });
    expect(mp?.items.slice(1).every((item) => item.locked === true)).toBe(true);
    expect(dm?.items.every((item) => item.locked === true)).toBe(true);

    const serialized = JSON.stringify(manifest);
    for (const project of configuration.projects) {
      for (const item of project.items) {
        const selected = project.protected || ("protected" in item && item.protected === true);
        if (!selected) continue;
        expect(serialized).not.toContain(item.sourcePath);
        if ("routeId" in item) expect(serialized).not.toContain(item.routeId);
        if ("r2Key" in item) expect(serialized).not.toContain(item.r2Key);
        if ("sha256" in item) expect(serialized).not.toContain(item.sha256);
      }
    }
  });

  it("keys every public source and poster URL to its current content bytes", async () => {
    const versions = await currentPublicMediaVersions();
    const manifest = createPublicPortfolioManifest(configuration, versions);

    for (const [projectIndex, project] of configuration.projects.entries()) {
      for (const [itemIndex, item] of project.items.entries()) {
        const selected = project.protected || ("protected" in item && item.protected === true);
        if (selected) continue;
        const generated = manifest.projects[projectIndex].items[itemIndex];
        expect(new URL(generated.url, "https://example.test/Resume/").searchParams.get("v")).toBe(
          versions[item.sourcePath],
        );
        if ("posterPath" in item) {
          expect(
            new URL(generated.poster, "https://example.test/Resume/").searchParams.get("v"),
          ).toBe(versions[item.posterPath]);
        }
      }
    }
  });

  it("changes a same-path URL when bytes change and omits protected media from versions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "portfolio-public-media-version-"));
    const publicSourcePath = "공개/asset.jpg";
    const protectedSourcePath = "비공개/secret.jpg";
    const syntheticConfiguration = {
      projects: [
        {
          id: "synthetic",
          title: "Synthetic",
          protected: false,
          items: [
            { id: "public", title: "Public", type: "image", sourcePath: publicSourcePath },
            {
              id: "protected",
              title: "Protected",
              type: "image",
              sourcePath: protectedSourcePath,
              protected: true,
            },
          ],
        },
      ],
    };
    await mkdir(path.join(root, "공개"), { recursive: true });

    try {
      await writeFile(path.join(root, publicSourcePath), "first bytes");
      const firstVersions = await createPublicMediaVersions(syntheticConfiguration, root);
      const first = createPublicPortfolioManifest(syntheticConfiguration, firstVersions);

      await writeFile(path.join(root, publicSourcePath), "replacement bytes");
      const replacementVersions = await createPublicMediaVersions(syntheticConfiguration, root);
      const replacement = createPublicPortfolioManifest(
        syntheticConfiguration,
        replacementVersions,
      );

      expect(Object.keys(firstVersions)).toEqual([publicSourcePath]);
      expect(first.projects[0].items[0].url).not.toBe(replacement.projects[0].items[0].url);
      expect(new URL(replacement.projects[0].items[0].url, "https://example.test/").searchParams.get("v"))
        .toBe(createHash("sha256").update("replacement bytes").digest("hex"));
      expect(JSON.stringify(replacement)).not.toContain(protectedSourcePath);
      expect(() => createPublicPortfolioManifest(syntheticConfiguration, {})).toThrow(
        "Generated public media versions do not match configured public assets",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a valid-looking stale digest for bytes under a public root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "portfolio-public-root-digest-"));
    const sourcePath = "media/asset.jpg";
    const bytes = Buffer.from("current deployed public bytes");
    await mkdir(path.join(root, "media"));
    await writeFile(path.join(root, sourcePath), bytes);

    try {
      const module = (await import("../../scripts/public-manifest.mjs")) as unknown as Record<
        string,
        unknown
      >;
      expect(module.validatePublicMediaRoot).toBeTypeOf("function");
      const validatePublicMediaRoot = module.validatePublicMediaRoot as (options: {
        mediaVersions: Record<string, string>;
        root: string;
        sourcePaths: string[];
      }) => Promise<void>;
      await expect(
        validatePublicMediaRoot({
          mediaVersions: { [sourcePath]: "0".repeat(64) },
          root,
          sourcePaths: [sourcePath],
        }),
      ).rejects.toThrow(/digest|SHA-256|version|bytes/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the stable BigInt file snapshot captured by digest validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "portfolio-public-root-snapshot-"));
    const sourcePath = "media/asset.jpg";
    const source = path.join(root, sourcePath);
    const bytes = Buffer.from("startup snapshot bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(path.dirname(source));
    await writeFile(source, bytes);

    try {
      const snapshots = await validatePublicMediaRoot({
        mediaVersions: { [sourcePath]: digest },
        root,
        sourcePaths: [sourcePath],
      });
      const expected = await lstat(source, { bigint: true });
      const snapshot = snapshots.get(sourcePath);

      expect([...snapshots.keys()]).toEqual([sourcePath]);
      expect(snapshot).toEqual({
        birthtimeNs: expected.birthtimeNs,
        ctimeNs: expected.ctimeNs,
        dev: expected.dev,
        ino: expected.ino,
        mode: expected.mode,
        mtimeNs: expected.mtimeNs,
        nlink: expected.nlink,
        size: expected.size,
      });
      expect(Object.values(snapshot!)).toSatisfy((values: unknown[]) =>
        values.every((value) => typeof value === "bigint"),
      );
      expect(Object.isFrozen(snapshot)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a public source beneath a symlinked parent without hashing outside bytes", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "portfolio-public-media-parent-link-"));
    const root = path.join(fixture, "repository");
    const outside = path.join(fixture, "outside");
    const sourcePath = "media/asset.jpg";
    const syntheticConfiguration = {
      projects: [
        {
          id: "synthetic",
          title: "Synthetic",
          protected: false,
          items: [{ id: "public", title: "Public", type: "image", sourcePath }],
        },
      ],
    };
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "asset.jpg"), "outside bytes must not be hashed");
    await symlink(outside, path.join(root, "media"), "dir");

    try {
      await expect(createPublicMediaVersions(syntheticConfiguration, root)).rejects.toThrow(
        /symlink|symbolic|outside|escape/iu,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("keeps generated public versions free of every protected path and hash", () => {
    const generated = generatedPublicMediaVersions as Readonly<Record<string, string>>;
    for (const project of configuration.projects) {
      for (const item of project.items) {
        const selected = project.protected || ("protected" in item && item.protected === true);
        if (!selected) continue;
        expect(generated).not.toHaveProperty(item.sourcePath);
        if ("sha256" in item) expect(Object.values(generated)).not.toContain(item.sha256);
      }
    }
  });
});

describe("public manifest artifact generation", () => {
  it.each(["public-media-versions.json", "public-portfolio-manifest.json"])(
    "rejects a symlink at generated destination %s without changing its target",
    async (artifactName) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "portfolio-generated-artifact-link-"));
      const root = path.join(fixture, "repository");
      const scripts = path.join(root, "scripts");
      const sourcePath = "media/asset.jpg";
      const sentinel = path.join(fixture, `${artifactName}.sentinel`);
      const sentinelBytes = Buffer.from("outside sentinel bytes must remain unchanged\n");
      await mkdir(scripts, { recursive: true });
      await mkdir(path.join(root, "config"));
      await mkdir(path.join(root, "media"));
      await writeFile(
        path.join(scripts, "public-manifest.mjs"),
        await readFile(path.join(repositoryRoot, "scripts", "public-manifest.mjs")),
      );
      await writeFile(
        path.join(scripts, "generate-public-manifest.mjs"),
        await readFile(path.join(repositoryRoot, "scripts", "generate-public-manifest.mjs")),
      );
      await writeFile(
        path.join(root, "config", "portfolio-manifest.json"),
        JSON.stringify({
          projects: [
            {
              id: "synthetic",
              title: "Synthetic",
              protected: false,
              items: [{ id: "public", title: "Public", type: "image", sourcePath }],
            },
          ],
        }),
      );
      await writeFile(path.join(root, sourcePath), "public fixture bytes");
      await writeFile(sentinel, sentinelBytes);
      await symlink(sentinel, path.join(root, artifactName), "file");

      try {
        await expect(
          execFileAsync(process.execPath, [path.join(scripts, "generate-public-manifest.mjs")]),
        ).rejects.toThrow();
        expect(await readFile(sentinel)).toEqual(sentinelBytes);
        expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it.each(["public-media-versions.json", "public-portfolio-manifest.json"])(
    "check mode rejects an exact-byte outside symlink at %s without changing its target",
    async (artifactName) => {
      const fixture = await mkdtemp(path.join(tmpdir(), "portfolio-generated-check-link-"));
      const root = path.join(fixture, "repository");
      const scripts = path.join(root, "scripts");
      const sourcePath = "media/asset.jpg";
      const destination = path.join(root, artifactName);
      const sentinel = path.join(fixture, `${artifactName}.sentinel`);
      await mkdir(scripts, { recursive: true });
      await mkdir(path.join(root, "config"));
      await mkdir(path.join(root, "media"));
      await writeFile(
        path.join(scripts, "public-manifest.mjs"),
        await readFile(path.join(repositoryRoot, "scripts", "public-manifest.mjs")),
      );
      await writeFile(
        path.join(scripts, "generate-public-manifest.mjs"),
        await readFile(path.join(repositoryRoot, "scripts", "generate-public-manifest.mjs")),
      );
      await writeFile(
        path.join(root, "config", "portfolio-manifest.json"),
        JSON.stringify({
          projects: [
            {
              id: "synthetic",
              title: "Synthetic",
              protected: false,
              items: [{ id: "public", title: "Public", type: "image", sourcePath }],
            },
          ],
        }),
      );
      await writeFile(path.join(root, sourcePath), "public fixture bytes");

      try {
        await execFileAsync(process.execPath, [path.join(scripts, "generate-public-manifest.mjs")]);
        const expectedBytes = await readFile(destination);
        await writeFile(sentinel, expectedBytes);
        await unlink(destination);
        await symlink(sentinel, destination, "file");

        await expect(
          execFileAsync(process.execPath, [
            path.join(scripts, "generate-public-manifest.mjs"),
            "--check",
          ]),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(`${artifactName} is stale`),
        });
        expect(await readFile(sentinel)).toEqual(expectedBytes);
        expect((await lstat(destination)).isSymbolicLink()).toBe(true);
        expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );
});
