import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExternalProtectedMediaStore } from "../../src/media-store";
import type { ProtectedItem } from "../../src/portfolio";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "portfolio-media-store-"));
  roots.push(root);
  return root;
}

function item(sourcePath: string, bytes: Buffer): ProtectedItem {
  return {
    contentType: "image/jpeg",
    id: "synthetic-item",
    routeId: "synthetic-route",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourcePath,
    title: "Synthetic",
    type: "image",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external protected-media validation", () => {
  it("validates hashes at startup and revalidates before streaming", async () => {
    const root = await temporaryRoot();
    const mediaRoot = path.join(root, "originals");
    const bytes = Buffer.from("reviewed protected bytes");
    await mkdir(path.join(mediaRoot, "nested"), { recursive: true });
    await writeFile(path.join(mediaRoot, "nested", "image.jpg"), bytes);
    const configured = item("nested/image.jpg", bytes);
    const store = await createExternalProtectedMediaStore({
      root: mediaRoot,
      repositoryRoot: path.join(root, "checkout"),
      items: [configured],
    });

    const opened = await store.open(configured);
    const body = Buffer.from(await new Response(opened.createBody()).arrayBuffer());
    expect(body).toEqual(bytes);

    await writeFile(path.join(mediaRoot, "nested", "image.jpg"), Buffer.from("tampered bytes"));
    await expect(store.open(configured)).rejects.toThrow(/integrity|SHA-256/iu);
  });

  it("fails startup on a declared hash mismatch", async () => {
    const root = await temporaryRoot();
    const mediaRoot = path.join(root, "originals");
    const bytes = Buffer.from("actual bytes");
    await mkdir(mediaRoot);
    await writeFile(path.join(mediaRoot, "image.jpg"), bytes);
    const configured = { ...item("image.jpg", bytes), sha256: "0".repeat(64) };

    await expect(
      createExternalProtectedMediaStore({
        root: mediaRoot,
        repositoryRoot: path.join(root, "checkout"),
        items: [configured],
      }),
    ).rejects.toThrow(/SHA-256|hash/iu);
  });

  it("rejects traversal, symlinked sources, and a root inside the checkout", async () => {
    const root = await temporaryRoot();
    const checkout = path.join(root, "checkout");
    const mediaRoot = path.join(root, "originals");
    const outside = path.join(root, "outside.jpg");
    const bytes = Buffer.from("outside bytes");
    await mkdir(mediaRoot);
    await mkdir(checkout);
    await writeFile(outside, bytes);
    await symlink(outside, path.join(mediaRoot, "linked.jpg"));

    await expect(
      createExternalProtectedMediaStore({
        root: mediaRoot,
        repositoryRoot: checkout,
        items: [item("../outside.jpg", bytes)],
      }),
    ).rejects.toThrow(/escape|relative|path/iu);

    await expect(
      createExternalProtectedMediaStore({
        root: mediaRoot,
        repositoryRoot: checkout,
        items: [item("linked.jpg", bytes)],
      }),
    ).rejects.toThrow(/symbolic|symlink|regular/iu);

    const mediaInsideCheckout = path.join(checkout, "originals");
    await mkdir(mediaInsideCheckout);
    await writeFile(path.join(mediaInsideCheckout, "image.jpg"), bytes);
    await expect(
      createExternalProtectedMediaStore({
        root: mediaInsideCheckout,
        repositoryRoot: checkout,
        items: [item("image.jpg", bytes)],
      }),
    ).rejects.toThrow(/outside.*repository|checkout/iu);
  });
});
