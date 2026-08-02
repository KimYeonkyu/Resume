import manifest from "../config/portfolio-manifest.json";

type ConfiguredItem = (typeof manifest.projects)[number]["items"][number];

export interface ProtectedItem {
  contentType: string;
  id: string;
  r2Key: string;
  routeId: string;
  title: string;
  type: "image";
}

function publicAssetUrl(sourcePath: string): string {
  return `/${sourcePath.split("/").map(encodeURIComponent).join("/")}`;
}

function protectedItem(item: ConfiguredItem): ProtectedItem | null {
  if (!("routeId" in item) || !("r2Key" in item) || !("contentType" in item)) return null;
  return {
    contentType: item.contentType,
    id: item.id,
    r2Key: item.r2Key,
    routeId: item.routeId,
    title: item.title,
    type: "image",
  };
}

const protectedItems = manifest.projects
  .filter((project) => project.protected)
  .flatMap((project) => project.items.map(protectedItem))
  .filter((item): item is ProtectedItem => item !== null);

const protectedItemsByRouteId = new Map(protectedItems.map((item) => [item.routeId, item]));

export function findProtectedItem(routeId: string): ProtectedItem | undefined {
  return protectedItemsByRouteId.get(routeId);
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
    ) ||
    excludedFiles.includes(decodedPath)
  );
}

export function projectManifest(authenticated: boolean) {
  return {
    authenticated,
    projects: manifest.projects.map((project) => {
      if (project.protected && !authenticated) {
        return {
          id: project.id,
          title: project.title,
          protected: true,
          locked: true,
          itemCount: project.items.length,
          items: project.items.map((_, index) => ({
            id: `locked-${project.id}-${index + 1}`,
            title: "비공개 작품",
            type: "locked",
            locked: true,
          })),
        };
      }

      return {
        id: project.id,
        title: project.title,
        protected: project.protected,
        locked: false,
        itemCount: project.items.length,
        items: project.items.map((item) => {
          if (project.protected) {
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
