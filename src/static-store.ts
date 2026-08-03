import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export interface PublicAssetStore {
  response(rawPathname: string, method: "GET" | "HEAD"): Promise<Response | null>;
}

interface PublicAsset {
  contentType: string;
  source: string;
}

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
]);

function inside(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function validateAllowedPath(relativePath: string): string[] {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Public asset allowlist contains an invalid path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Public asset allowlist path escapes its root");
  }
  return segments;
}

async function walk(root: string, directory = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error("Public asset root must not contain symlinks");
    if (info.isDirectory()) output.push(...(await walk(root, absolute)));
    else if (info.isFile()) output.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error("Public asset root contains a non-regular entry");
  }
  return output;
}

function requestAssetPath(rawPathname: string): string | null {
  if (
    !rawPathname.startsWith("/") ||
    rawPathname.startsWith("//") ||
    rawPathname.length > 2_048 ||
    /%(?:2f|5c)/iu.test(rawPathname)
  ) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname).normalize("NFC");
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("#")) return null;
  if (decoded === "/") return "index.html";
  if (decoded.endsWith("/")) return null;
  const segments = decoded.slice(1).split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

async function openPinnedFile(root: string, source: string): Promise<{ handle: FileHandle; size: number }> {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Public asset changed type");
  const resolved = await realpath(source);
  if (!inside(root, resolved)) throw new Error("Public asset resolves outside its root");
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(resolved, constants.O_RDONLY | noFollow);
  try {
    const handleInfo = await handle.stat();
    if (!handleInfo.isFile() || handleInfo.dev !== info.dev || handleInfo.ino !== info.ino) {
      throw new Error("Public asset changed during open");
    }
    return { handle, size: handleInfo.size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function createPublicAssetStore(options: {
  allowedPaths: ReadonlySet<string>;
  ignoredPaths?: ReadonlySet<string>;
  root: string;
}): Promise<PublicAssetStore> {
  if (!path.isAbsolute(options.root)) throw new Error("Public asset root must be absolute");
  const rootInfo = await lstat(options.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Public asset root must be a real directory, not a symlink");
  }
  const resolvedRoot = await realpath(options.root);
  const ignored = options.ignoredPaths ?? new Set([".assetsignore"]);
  const actualPaths = new Set(await walk(resolvedRoot));
  const assets = new Map<string, PublicAsset>();

  for (const relativePath of options.allowedPaths) {
    const segments = validateAllowedPath(relativePath);
    if (!actualPaths.has(relativePath)) {
      throw new Error(`Public build is missing an allowlisted asset: ${relativePath}`);
    }
    const source = path.resolve(resolvedRoot, ...segments);
    if (!inside(resolvedRoot, source)) throw new Error("Public asset path escapes its root");
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Public allowlist entries must be regular files");
    }
    const resolvedSource = await realpath(source);
    if (!inside(resolvedRoot, resolvedSource)) throw new Error("Public asset resolves outside its root");
    const contentType = CONTENT_TYPES.get(path.extname(relativePath).toLowerCase());
    if (!contentType) throw new Error(`Public asset has an unsupported extension: ${relativePath}`);
    assets.set(relativePath, { contentType, source: resolvedSource });
  }
  for (const actualPath of actualPaths) {
    if (!assets.has(actualPath) && !ignored.has(actualPath)) {
      throw new Error(`Public build contains an unexpected file: ${actualPath}`);
    }
  }

  return {
    async response(rawPathname, method) {
      const assetPath = requestAssetPath(rawPathname);
      if (!assetPath) return null;
      const asset = assets.get(assetPath);
      if (!asset) return null;
      const opened = await openPinnedFile(resolvedRoot, asset.source);
      const headers = new Headers({
        "Cache-Control": assetPath.endsWith(".html") ? "no-cache" : "public, max-age=3600",
        "Content-Length": String(opened.size),
        "Content-Type": asset.contentType,
      });
      if (method === "HEAD") {
        await opened.handle.close();
        return new Response(null, { status: 200, headers });
      }
      const nodeStream = opened.handle.createReadStream({ autoClose: true, start: 0 });
      return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
        status: 200,
        headers,
      });
    },
  };
}
