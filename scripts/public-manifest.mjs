function encodeRelativePath(sourcePath) {
  return sourcePath.split("/").map(encodeURIComponent).join("/");
}

function itemIsProtected(project, item) {
  return project.protected === true || item.protected === true;
}

export function createPublicPortfolioManifest(configuration) {
  return {
    authenticated: false,
    projects: configuration.projects.map((project) => {
      const itemProtection = project.items.map((item) => itemIsProtected(project, item));
      const hasProtectedItems = itemProtection.some(Boolean);
      return {
        id: project.id,
        title: project.title,
        protected: hasProtectedItems,
        locked: hasProtectedItems,
        itemCount: project.items.length,
        items: project.items.map((item, index) => {
          if (itemProtection[index]) {
            return {
              id: `locked-${project.id}-${index + 1}`,
              title: "비공개 작품",
              type: "locked",
              locked: true,
            };
          }
          return {
            id: item.id,
            title: item.title,
            category: project.title,
            type: item.type,
            description: item.description ?? `${project.title} · ${item.title}`,
            url: encodeRelativePath(item.sourcePath),
            ...(item.posterPath ? { poster: encodeRelativePath(item.posterPath) } : {}),
          };
        }),
      };
    }),
  };
}

export function serializePublicPortfolioManifest(configuration) {
  return `${JSON.stringify(createPublicPortfolioManifest(configuration), null, 2)}\n`;
}
