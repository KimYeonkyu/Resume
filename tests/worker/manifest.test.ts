import { describe, expect, it, vi } from "vitest";

import portfolioManifest from "../../config/portfolio-manifest.json";
import worker from "../../src/worker";
import { cookiePair, loginRequest, makeTestEnv } from "./helpers";

type ManifestProject = {
  id: string;
  itemCount: number;
  items: Array<Record<string, unknown>>;
  locked: boolean;
  protected: boolean;
  title: string;
};

async function authenticatedFixture() {
  const { env, password } = await makeTestEnv();
  const login = await worker.fetch(loginRequest(password), env);
  return { env, cookie: cookiePair(login.headers.get("Set-Cookie") ?? "") };
}

function projectById(projects: ManifestProject[], id: string): ManifestProject {
  const project = projects.find((candidate) => candidate.id === id);
  if (!project) throw new Error(`Missing project ${id}`);
  return project;
}

describe("session-filtered project manifest", () => {
  it("returns safe locked placeholders and no protected names, keys, or URLs to guests", async () => {
    const { env } = await makeTestEnv();
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/projects"),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    const body = (await response.json()) as { authenticated: boolean; projects: ManifestProject[] };
    expect(body.authenticated).toBe(false);

    const protectedProjects = portfolioManifest.projects.filter((project) => project.protected);
    for (const configuredProject of protectedProjects) {
      const project = projectById(body.projects, configuredProject.id);
      expect(project).toMatchObject({
        itemCount: configuredProject.items.length,
        locked: true,
        protected: true,
        title: configuredProject.title,
      });
      expect(project.items).toHaveLength(configuredProject.items.length);
      const serializedProject = JSON.stringify(project);
      for (const placeholder of project.items) {
        expect(Object.keys(placeholder).sort()).toEqual(["id", "locked", "title", "type"]);
        expect(placeholder).toMatchObject({ locked: true, type: "locked" });
      }
      for (const item of configuredProject.items) {
        expect(serializedProject).not.toContain(item.sourcePath.split("/").at(-1));
      }
    }

    const serialized = JSON.stringify(body);
    for (const project of protectedProjects) {
      for (const item of project.items) {
        if (!("r2Key" in item) || !("routeId" in item)) {
          throw new Error("Protected configuration item is missing private routing fields");
        }
        expect(serialized).not.toContain(item.sourcePath);
        expect(serialized).not.toContain(item.r2Key);
        expect(serialized).not.toContain(item.routeId);
      }
    }
    expect(serialized).not.toContain("/protected/");
  });

  it("returns usable opaque URLs for every protected item after one login", async () => {
    const { env, cookie } = await authenticatedFixture();
    const get = vi.mocked(env.PROTECTED_MEDIA.get);
    get.mockImplementation(async (key: string) => ({
      body: new Response(key).body,
      httpMetadata: { contentType: "image/jpeg" },
    }) as R2ObjectBody);

    const response = await worker.fetch(
      new Request("https://portfolio.example/api/projects", { headers: { Cookie: cookie } }),
      env,
    );
    const body = (await response.json()) as { authenticated: boolean; projects: ManifestProject[] };
    expect(body.authenticated).toBe(true);

    const configuredProtected = portfolioManifest.projects.filter((project) => project.protected);
    const protectedUrls: string[] = [];
    for (const configuredProject of configuredProtected) {
      const project = projectById(body.projects, configuredProject.id);
      expect(project.locked).toBe(false);
      expect(project.items).toHaveLength(configuredProject.items.length);
      for (const item of project.items) {
        expect(Object.keys(item)).not.toContain("sourcePath");
        expect(Object.keys(item)).not.toContain("r2Key");
        expect(item.url).toMatch(/^\/protected\/[a-z0-9-]+$/u);
        protectedUrls.push(item.url as string);
      }
    }
    expect(new Set(protectedUrls).size).toBe(protectedUrls.length);

    for (const url of protectedUrls) {
      const mediaResponse = await worker.fetch(
        new Request(`https://portfolio.example${url}`, { headers: { Cookie: cookie } }),
        env,
      );
      expect(mediaResponse.status).toBe(200);
      expect(mediaResponse.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mediaResponse.headers.get("Content-Type")).toBe("image/jpeg");
      expect(mediaResponse.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    }
    expect(get).toHaveBeenCalledTimes(protectedUrls.length);
  });

  it("forces the guest-safe view when public mode is explicitly requested", async () => {
    const { env, cookie } = await authenticatedFixture();
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/projects?mode=public", {
        headers: { Cookie: cookie },
      }),
      env,
    );
    const body = (await response.json()) as { authenticated: boolean; projects: ManifestProject[] };

    expect(body.authenticated).toBe(false);
    expect(body.projects.filter((project) => project.protected).every((project) => project.locked)).toBe(
      true,
    );
  });

  it("serializes every configured public image and local video for the browser", async () => {
    const { env } = await makeTestEnv();
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/projects?mode=public"),
      env,
    );
    const body = (await response.json()) as { projects: ManifestProject[] };

    for (const configuredProject of portfolioManifest.projects.filter(
      (project) => !project.protected,
    )) {
      const project = projectById(body.projects, configuredProject.id);
      expect(project).toMatchObject({
        itemCount: configuredProject.items.length,
        locked: false,
        protected: false,
        title: configuredProject.title,
      });
      configuredProject.items.forEach((configuredItem, index) => {
        const item = project.items[index];
        const expectedUrl = `/${configuredItem.sourcePath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`;
        expect(item).toMatchObject({
          id: configuredItem.id,
          title: configuredItem.title,
          type: configuredItem.type,
          url: expectedUrl,
        });
        if ("posterPath" in configuredItem && typeof configuredItem.posterPath === "string") {
          expect(item.poster).toBe(
            `/${configuredItem.posterPath.split("/").map(encodeURIComponent).join("/")}`,
          );
        } else {
          expect(item).not.toHaveProperty("poster");
        }
      });
    }
  });
});

describe("protected path validation", () => {
  it.each([
    "/protected/unknown",
    "/protected/mp-001/extra",
    "/protected/%2Fetc",
    "/protected/%5Cwindows",
    "/protected/%00",
    "/protected/%252e%252e",
    `/protected/${"a".repeat(129)}`,
  ])("rejects %s without reading R2 or falling through to assets", async (path) => {
    const { env, cookie } = await authenticatedFixture();
    const response = await worker.fetch(
      new Request(`https://portfolio.example${path}`, { headers: { Cookie: cookie } }),
      env,
    );

    expect([400, 404]).toContain(response.status);
    expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("rejects expired and tampered cookies before reading R2", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const { env, cookie } = await authenticatedFixture();
      const finalCharacter = cookie.at(-1);
      const tamperedCookie = `${cookie.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
      const tampered = await worker.fetch(
        new Request("https://portfolio.example/protected/mp-001", {
          headers: { Cookie: tamperedCookie },
        }),
        env,
      );
      expect(tampered.status).toBe(401);
      expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();

      vi.advanceTimersByTime(7_200_001);
      const expired = await worker.fetch(
        new Request("https://portfolio.example/protected/dm-001", {
          headers: { Cookie: cookie },
        }),
        env,
      );
      expect(expired.status).toBe(401);
      expect(env.PROTECTED_MEDIA.get).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
