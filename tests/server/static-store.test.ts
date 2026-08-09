import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPublicAssetStore } from "../../src/static-store";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "portfolio-public-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("versioned public-media startup validation", () => {
  it("serves unchanged GET and concurrent HEAD requests without request-path content hashing", async () => {
    const root = await temporaryRoot();
    const sourcePath = "media/asset.jpg";
    const source = path.join(root, sourcePath);
    const expectedBytes = Buffer.from("startup-validated versioned public media bytes");
    const expectedDigest = createHash("sha256").update(expectedBytes).digest("hex");
    await mkdir(path.dirname(source));
    await writeFile(source, expectedBytes);
    const store = await createPublicAssetStore({
      allowedPaths: new Set([sourcePath]),
      mediaVersions: { [sourcePath]: expectedDigest },
      root,
      versionedPaths: new Set([sourcePath]),
    });

    const get = await store.response(`/${sourcePath}`, "GET");
    expect(get).not.toBeNull();
    const body = Buffer.from(await get!.arrayBuffer());
    expect(body).toEqual(expectedBytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(expectedDigest);
    expect(get!.headers.get("content-length")).toBe(String(expectedBytes.byteLength));
    expect(get!.headers.get("content-type")).toBe("image/jpeg");
    expect(get!.headers.get("cache-control")).toBe("public, max-age=3600");

    const heads = await Promise.all(
      Array.from({ length: 64 }, () => store.response(`/${sourcePath}`, "HEAD")),
    );
    for (const head of heads) {
      expect(head).not.toBeNull();
      expect((await head!.arrayBuffer()).byteLength).toBe(0);
      expect(head!.headers.get("content-length")).toBe(String(expectedBytes.byteLength));
      expect(head!.headers.get("content-type")).toBe("image/jpeg");
      expect(head!.headers.get("cache-control")).toBe("public, max-age=3600");
    }

    const implementation = await readFile(new URL("../../src/static-store.ts", import.meta.url), "utf8");
    expect(implementation).not.toContain('from "node:crypto"');
    expect(implementation).not.toContain("createHash");
  });

  it("rejects a byte mismatch while creating the store, before any asset can be served", async () => {
    const root = await temporaryRoot();
    const sourcePath = "media/asset.jpg";
    await mkdir(path.join(root, "media"));
    await writeFile(path.join(root, sourcePath), "deployed bytes do not match bundle");

    await expect(
      createPublicAssetStore({
        allowedPaths: new Set([sourcePath]),
        mediaVersions: { [sourcePath]: "0".repeat(64) },
        root,
        versionedPaths: new Set([sourcePath]),
      }),
    ).rejects.toThrow(/digest|SHA-256|version|bytes/iu);
  });

  it.each(["GET", "HEAD"] as const)(
    "rejects %s after a versioned file's bytes drift in place after store creation",
    async (method) => {
      const root = await temporaryRoot();
      const sourcePath = "media/asset.jpg";
      const source = path.join(root, sourcePath);
      const expectedBytes = Buffer.from("expected deployed public bytes");
      const driftedBytes = Buffer.alloc(expectedBytes.byteLength, 0x78);
      const expectedDigest = createHash("sha256").update(expectedBytes).digest("hex");
      await mkdir(path.dirname(source));
      await writeFile(source, expectedBytes);
      const store = await createPublicAssetStore({
        allowedPaths: new Set([sourcePath]),
        mediaVersions: { [sourcePath]: expectedDigest },
        root,
        versionedPaths: new Set([sourcePath]),
      });

      await writeFile(source, driftedBytes);

      await expect(store.response(`/${sourcePath}`, method)).rejects.toThrow(
        /digest|SHA-256|version|bytes/iu,
      );
    },
  );
});
