export const rootPublicFiles = Object.freeze([
  "GOT.pdf",
  "Jin_Kim_Resume.pdf",
  "NYPC Ranking.jpg",
  "NYPC ranking.pdf",
  "dominionion.jpg",
  "dominionion.pdf",
  "index.html",
  "jin-kim-cover.webp",
  "jin_kim_portfolio.html",
  "portfolio.css",
  "portfolio.js",
  "public-portfolio-manifest.json",
  "개인작.pdf",
]);

export function expectedPublicFiles(manifest) {
  const files = new Set(rootPublicFiles);
  for (const project of manifest.projects) {
    for (const item of project.items) {
      if (project.protected === true || item.protected === true) continue;
      files.add(item.sourcePath);
      if (item.posterPath) files.add(item.posterPath);
    }
  }
  files.add(".assetsignore");
  files.add("resume.css");
  return files;
}
