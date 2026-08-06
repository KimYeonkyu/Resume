import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { ProtectedItem } from "./portfolio";

export interface OpenedProtectedMedia {
  close(): Promise<void>;
  createBody(): ReadableStream<Uint8Array>;
  size: number;
}

export interface ProtectedMediaStore {
  open(item: ProtectedItem): Promise<OpenedProtectedMedia>;
}

interface StoredItem {
  item: ProtectedItem;
  source: string;
}

export class ProtectedMediaIntegrityError extends Error {
  constructor(message = "Protected media integrity validation failed") {
    super(message);
    this.name = "ProtectedMediaIntegrityError";
  }
}

function pathInside(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function validateSourcePath(sourcePath: string): string[] {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length === 0 ||
    sourcePath.length > 512 ||
    sourcePath.includes("\0") ||
    sourcePath.includes("\\") ||
    path.isAbsolute(sourcePath)
  ) {
    throw new Error("Protected source path must be a safe relative path");
  }
  const segments = sourcePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Protected source path may not escape the private root");
  }
  return segments;
}

async function sha256Handle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function openVerifiedSource(
  root: string,
  source: string,
  expectedSha256: string,
): Promise<{ handle: FileHandle; size: number }> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("Protected source must be a regular file and not a symbolic link");
  }
  const resolvedSource = await realpath(source);
  if (!pathInside(root, resolvedSource)) {
    throw new Error("Protected source resolves outside the private media root");
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(resolvedSource, constants.O_RDONLY | noFollow);
  try {
    const [handleInfo, currentInfo] = await Promise.all([handle.stat(), lstat(resolvedSource)]);
    if (
      !handleInfo.isFile() ||
      !currentInfo.isFile() ||
      currentInfo.isSymbolicLink() ||
      handleInfo.dev !== currentInfo.dev ||
      handleInfo.ino !== currentInfo.ino
    ) {
      throw new Error("Protected source changed during validation");
    }
    const actualSha256 = await sha256Handle(handle);
    if (actualSha256 !== expectedSha256) {
      throw new ProtectedMediaIntegrityError(
        "Protected source bytes do not match the reviewed SHA-256 manifest",
      );
    }
    return { handle, size: handleInfo.size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function openedMedia(handle: FileHandle, size: number): OpenedProtectedMedia {
  let bodyCreated = false;
  let closed = false;
  return {
    size,
    createBody() {
      if (bodyCreated || closed) throw new Error("Protected media handle has already been consumed");
      bodyCreated = true;
      const nodeStream = handle.createReadStream({ autoClose: true, start: 0 });
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    },
    async close() {
      if (bodyCreated || closed) return;
      closed = true;
      await handle.close();
    },
  };
}

export async function createExternalProtectedMediaStore(options: {
  items: readonly ProtectedItem[];
  repositoryRoot: string;
  root: string;
}): Promise<ProtectedMediaStore> {
  if (!path.isAbsolute(options.root)) {
    throw new Error("Protected media root must be an absolute external path");
  }
  const rootInfo = await lstat(options.root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Protected media root must be a real directory, not a symlink");
  }
  const resolvedRoot = await realpath(options.root);
  const configuredRepositoryRoot = path.resolve(options.repositoryRoot);
  const resolvedRepositoryRoot = await realpath(configuredRepositoryRoot).catch(
    () => configuredRepositoryRoot,
  );
  if (
    resolvedRoot === resolvedRepositoryRoot ||
    resolvedRoot.startsWith(`${resolvedRepositoryRoot}${path.sep}`)
  ) {
    throw new Error("Protected media root must stay outside the public repository checkout");
  }

  const stored = new Map<string, StoredItem>();
  const sourcePaths = new Set<string>();
  for (const item of options.items) {
    if (
      !/^[a-z0-9-]{1,64}$/u.test(item.routeId) ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      item.contentType !== "image/jpeg"
    ) {
      throw new Error("Protected manifest contains an invalid route, digest, or content type");
    }
    if (stored.has(item.routeId) || sourcePaths.has(item.sourcePath)) {
      throw new Error("Protected manifest contains duplicate routes or source paths");
    }
    const segments = validateSourcePath(item.sourcePath);
    const source = path.resolve(resolvedRoot, ...segments);
    if (!pathInside(resolvedRoot, source)) {
      throw new Error("Protected source path escapes the private media root");
    }
    const validated = await openVerifiedSource(resolvedRoot, source, item.sha256);
    await validated.handle.close();
    stored.set(item.routeId, { item, source });
    sourcePaths.add(item.sourcePath);
  }
  if (stored.size === 0) throw new Error("Protected media catalog must not be empty");

  return {
    async open(item: ProtectedItem): Promise<OpenedProtectedMedia> {
      const configured = stored.get(item.routeId);
      if (
        !configured ||
        configured.item.id !== item.id ||
        configured.item.sourcePath !== item.sourcePath ||
        configured.item.sha256 !== item.sha256
      ) {
        throw new ProtectedMediaIntegrityError("Protected route is not in the validated catalog");
      }
      const validated = await openVerifiedSource(resolvedRoot, configured.source, item.sha256);
      return openedMedia(validated.handle, validated.size);
    },
  };
}
