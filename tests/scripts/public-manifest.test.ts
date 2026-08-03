import { describe, expect, it } from "vitest";

import configuration from "../../config/portfolio-manifest.json";
import { createPublicPortfolioManifest } from "../../scripts/public-manifest.mjs";

describe("static public portfolio manifest", () => {
  it("keeps public items usable while replacing every selected item with a safe placeholder", () => {
    const manifest = createPublicPortfolioManifest(configuration);
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
});
