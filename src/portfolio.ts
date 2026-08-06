import manifest from "../config/portfolio-manifest.json";

type ConfiguredProject = (typeof manifest.projects)[number];
type ConfiguredItem = ConfiguredProject["items"][number];

export interface ProtectedItem {
  contentType: string;
  id: string;
  routeId: string;
  sha256: string;
  sourcePath: string;
  title: string;
  type: "image";
}

const ROOT_PUBLIC_ASSETS = Object.freeze([
  "GOT.pdf",
  "Jin_Kim_Resume.pdf",
  "NYPC Ranking.jpg",
  "NYPC ranking.pdf",
  "dominionion.jpg",
  "dominionion.pdf",
  "index.html",
  "jin_kim_portfolio.html",
  "portfolio.css",
  "portfolio.js",
  "public-portfolio-manifest.json",
  "resume.css",
  "개인작.pdf",
]);

function publicAssetUrl(sourcePath: string): string {
  return `/${sourcePath.split("/").map(encodeURIComponent).join("/")}`;
}

function itemIsProtected(project: ConfiguredProject, item: ConfiguredItem): boolean {
  return project.protected || ("protected" in item && item.protected === true);
}

function protectedItem(item: ConfiguredItem): ProtectedItem | null {
  if (
    !("routeId" in item) ||
    !("contentType" in item) ||
    !("sha256" in item) ||
    typeof item.routeId !== "string" ||
    typeof item.contentType !== "string" ||
    typeof item.sha256 !== "string"
  ) {
    return null;
  }
  return {
    contentType: item.contentType,
    id: item.id,
    routeId: item.routeId,
    sha256: item.sha256,
    sourcePath: item.sourcePath,
    title: item.title,
    type: "image",
  };
}

function buildProtectedCatalog(): ProtectedItem[] {
  const items = manifest.projects.flatMap((project) =>
    project.items.filter((item) => itemIsProtected(project, item)).map((item) => {
      const configured = protectedItem(item);
      if (!configured) throw new Error("Protected portfolio item is missing required local-media fields");
      return configured;
    }),
  );
  const ids = new Set<string>();
  const routeIds = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id) || routeIds.has(item.routeId)) {
      throw new Error("Protected portfolio item IDs and route IDs must be unique");
    }
    if (!/^[a-z0-9-]{1,64}$/u.test(item.routeId)) {
      throw new Error("Protected portfolio route IDs must be opaque ASCII tokens");
    }
    if (!/^[a-f0-9]{64}$/u.test(item.sha256)) {
      throw new Error("Protected portfolio items require lowercase SHA-256 digests");
    }
    if (item.contentType !== "image/jpeg") {
      throw new Error("Protected portfolio item has an unsupported content type");
    }
    ids.add(item.id);
    routeIds.add(item.routeId);
  }
  return items;
}

const protectedItems = Object.freeze(buildProtectedCatalog());
const protectedItemsByRouteId = new Map(protectedItems.map((item) => [item.routeId, item]));

export function allProtectedItems(): readonly ProtectedItem[] {
  return protectedItems;
}

export function findProtectedItem(routeId: string): ProtectedItem | undefined {
  return protectedItemsByRouteId.get(routeId);
}

export function publicRuntimeAssetPaths(): ReadonlySet<string> {
  const paths = new Set<string>(ROOT_PUBLIC_ASSETS);
  for (const project of manifest.projects) {
    for (const item of project.items) {
      if (itemIsProtected(project, item)) continue;
      paths.add(item.sourcePath);
      if ("posterPath" in item && typeof item.posterPath === "string") paths.add(item.posterPath);
    }
  }
  return paths;
}

export function isLegacyProtectedPath(pathname: string): boolean {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname).normalize("NFC").toLowerCase();
  } catch {
    return false;
  }
  const excludedDirectories = manifest.deploymentExclusions.directories.map(
    (directory) => `/${directory.normalize("NFC").toLowerCase()}/`,
  );
  const excludedFiles = manifest.deploymentExclusions.files.map(
    (file) => `/${file.normalize("NFC").toLowerCase()}`,
  );
  return (
    excludedDirectories.some(
      (prefix) => decodedPath === prefix.slice(0, -1) || decodedPath.startsWith(prefix),
    ) || excludedFiles.includes(decodedPath)
  );
}

export function projectManifest(authenticated: boolean) {
  return {
    authenticated,
    projects: manifest.projects.map((project) => {
      const itemProtection = project.items.map((item) => itemIsProtected(project, item));
      const hasProtectedItems = itemProtection.some(Boolean);
      return {
        id: project.id,
        title: project.title,
        protected: hasProtectedItems,
        locked: hasProtectedItems && !authenticated,
        itemCount: project.items.length,
        items: project.items.map((item, index) => {
          if (itemProtection[index]) {
            if (!authenticated) {
              return {
                id: `locked-${project.id}-${index + 1}`,
                title: "비공개 작품",
                type: "locked",
                locked: true,
              };
            }
            const protectedMedia = protectedItem(item);
            if (!protectedMedia) throw new Error("Invalid protected portfolio manifest item");
            return {
              id: protectedMedia.id,
              title: protectedMedia.title,
              category: project.title,
              type: protectedMedia.type,
              description: `${project.title} · 보호된 작품`,
              url: `/protected/${protectedMedia.routeId}`,
            };
          }

          return {
            id: item.id,
            title: item.title,
            category: project.title,
            type: item.type,
            description:
              "description" in item ? item.description : `${project.title} · ${item.title}`,
            url: publicAssetUrl(item.sourcePath),
            ...("posterPath" in item ? { poster: publicAssetUrl(item.posterPath) } : {}),
          };
        }),
      };
    }),
  };
}

export { manifest as portfolioConfiguration };
