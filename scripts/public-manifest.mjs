import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function encodeRelativePath(sourcePath) {
  return sourcePath.split("/").map(encodeURIComponent).join("/");
}

function itemIsProtected(project, item) {
  return project.protected === true || item.protected === true;
}

export function publicMediaSourcePaths(configuration) {
  const sourcePaths = new Set();
  for (const project of configuration.projects) {
    for (const item of project.items) {
      if (itemIsProtected(project, item)) continue;
      sourcePaths.add(item.sourcePath);
      if (item.posterPath) sourcePaths.add(item.posterPath);
    }
  }
  return [...sourcePaths].sort();
}

function publicMediaPathSegments(repositoryRoot, sourcePath) {
  if (!path.isAbsolute(repositoryRoot)) throw new Error("Repository root must be absolute");
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length === 0 ||
    sourcePath.includes("\0") ||
    sourcePath.includes("\\") ||
    path.isAbsolute(sourcePath)
  ) {
    throw new Error("Public media source path is invalid");
  }
  const segments = sourcePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Public media source path escapes the repository");
  }
  const resolved = path.resolve(repositoryRoot, ...segments);
  if (!resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error("Public media source path escapes the repository");
  }
  return segments;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function stableFileSnapshot(info) {
  return Object.freeze({
    birthtimeNs: info.birthtimeNs,
    ctimeNs: info.ctimeNs,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    mtimeNs: info.mtimeNs,
    nlink: info.nlink,
    size: info.size,
  });
}

async function canonicalRepositoryRoot(repositoryRoot) {
  const configuredRoot = path.resolve(repositoryRoot);
  const configuredInfo = await lstat(configuredRoot, { bigint: true });
  if (!configuredInfo.isDirectory() || configuredInfo.isSymbolicLink()) {
    throw new Error("Repository root must be a real directory, not a symbolic link");
  }
  const resolvedRoot = await realpath(configuredRoot);
  const resolvedInfo = await lstat(resolvedRoot, { bigint: true });
  if (!resolvedInfo.isDirectory() || resolvedInfo.isSymbolicLink() || !sameIdentity(configuredInfo, resolvedInfo)) {
    throw new Error("Repository root changed during validation");
  }
  return { identity: resolvedInfo, path: resolvedRoot };
}

async function inspectPublicMediaPath(root, segments, sourcePath) {
  const currentRoot = await lstat(root.path, { bigint: true });
  if (
    !currentRoot.isDirectory() ||
    currentRoot.isSymbolicLink() ||
    !sameIdentity(currentRoot, root.identity)
  ) {
    throw new Error("Repository root changed during public media validation");
  }

  let current = root.path;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Public media parent must be a real directory, not a symlink: ${sourcePath}`);
    }
    const resolved = await realpath(current);
    const resolvedInfo = await lstat(resolved, { bigint: true });
    if (!pathInside(root.path, resolved) || !sameIdentity(info, resolvedInfo)) {
      throw new Error(`Public media parent resolves outside the repository: ${sourcePath}`);
    }
  }

  const source = path.join(root.path, ...segments);
  const info = await lstat(source, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Public media source must be a regular file: ${sourcePath}`);
  }
  const resolvedSource = await realpath(source);
  const resolvedInfo = await lstat(resolvedSource, { bigint: true });
  if (!pathInside(root.path, resolvedSource) || !sameIdentity(info, resolvedInfo)) {
    throw new Error(`Public media source resolves outside the repository: ${sourcePath}`);
  }
  return { info, source };
}

async function sha256Handle(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
  }
  return hash.digest("hex");
}

async function hashPinnedPublicMedia(root, segments, sourcePath) {
  const inspected = await inspectPublicMediaPath(root, segments, sourcePath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(inspected.source, constants.O_RDONLY | noFollow);
  try {
    const openedInfo = await handle.stat({ bigint: true });
    const openedPath = await inspectPublicMediaPath(root, segments, sourcePath);
    if (
      !openedInfo.isFile() ||
      !sameFileSnapshot(openedInfo, inspected.info) ||
      !sameFileSnapshot(openedInfo, openedPath.info)
    ) {
      throw new Error(`Public media source changed during open: ${sourcePath}`);
    }

    const digest = await sha256Handle(handle);
    const afterReadInfo = await handle.stat({ bigint: true });
    const afterReadPath = await inspectPublicMediaPath(root, segments, sourcePath);
    if (
      !afterReadInfo.isFile() ||
      !sameFileSnapshot(openedInfo, afterReadInfo) ||
      !sameFileSnapshot(afterReadInfo, afterReadPath.info)
    ) {
      throw new Error(`Public media source changed during hashing: ${sourcePath}`);
    }
    return { digest, snapshot: stableFileSnapshot(afterReadInfo) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function generatedArtifactSegments(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Generated artifact path is invalid");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Generated artifact path escapes the repository");
  }
  const destination = path.resolve(root, ...segments);
  if (!pathInside(root, destination)) {
    throw new Error("Generated artifact path escapes the repository");
  }
  return segments;
}

async function inspectGeneratedArtifact(root, segments, relativePath) {
  const currentRoot = await lstat(root.path, { bigint: true });
  if (
    !currentRoot.isDirectory() ||
    currentRoot.isSymbolicLink() ||
    !sameIdentity(currentRoot, root.identity)
  ) {
    throw new Error("Repository root changed during generated artifact validation");
  }

  let parent = root.path;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    const info = await lstat(parent, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Generated artifact parent must be a real directory: ${relativePath}`);
    }
    const resolvedParent = await realpath(parent);
    const resolvedInfo = await lstat(resolvedParent, { bigint: true });
    if (!pathInside(root.path, resolvedParent) || !sameIdentity(info, resolvedInfo)) {
      throw new Error(`Generated artifact parent resolves outside the repository: ${relativePath}`);
    }
  }

  const destination = path.join(root.path, ...segments);
  let info;
  try {
    info = await lstat(destination, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { destination, info: null, parent };
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Generated artifact destination must be a regular file: ${relativePath}`);
  }
  const resolvedDestination = await realpath(destination);
  const resolvedInfo = await lstat(resolvedDestination, { bigint: true });
  if (!pathInside(root.path, resolvedDestination) || !sameIdentity(info, resolvedInfo)) {
    throw new Error(`Generated artifact destination resolves outside the repository: ${relativePath}`);
  }
  return { destination, info, parent };
}

function destinationUnchanged(initial, current) {
  if (initial.info === null || current.info === null) return initial.info === current.info;
  return sameFileSnapshot(initial.info, current.info);
}

async function readExactHandle(handle, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
    if (bytesRead === 0) throw new Error("Generated artifact temporary file was truncated");
    offset += bytesRead;
  }
  return bytes;
}

async function syncDirectory(directory) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(directory, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error("Generated artifact parent changed type");
    try {
      await handle.sync();
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !["EINVAL", "ENOTSUP", "EBADF"].includes(error.code)
      ) {
        throw error;
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function cleanupGeneratedTemp(root, relativePath, identity) {
  try {
    const segments = generatedArtifactSegments(root.path, relativePath);
    const inspected = await inspectGeneratedArtifact(root, segments, relativePath);
    if (inspected.info && sameIdentity(inspected.info, identity)) await unlink(inspected.destination);
  } catch {
    // Never unlink an unverified path while handling an earlier write failure.
  }
}

async function writeGeneratedArtifact(root, relativePath, content, initial) {
  const segments = generatedArtifactSegments(root.path, relativePath);
  const beforeWrite = await inspectGeneratedArtifact(root, segments, relativePath);
  if (!destinationUnchanged(initial, beforeWrite)) {
    throw new Error(`Generated artifact destination changed before write: ${relativePath}`);
  }

  const temporaryRelativePath = `.${path.basename(relativePath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  const temporaryPath = path.join(beforeWrite.parent, temporaryRelativePath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    temporaryPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  let temporaryIdentity;
  let renamed = false;
  try {
    const openedInfo = await handle.stat({ bigint: true });
    if (!openedInfo.isFile()) throw new Error("Generated artifact temporary path is not a file");
    temporaryIdentity = openedInfo;
    await handle.chmod(0o644);
    const expectedBytes = Buffer.from(content, "utf8");
    await handle.writeFile(expectedBytes);
    await handle.sync();

    const writtenInfo = await handle.stat({ bigint: true });
    const temporary = await inspectGeneratedArtifact(
      root,
      generatedArtifactSegments(root.path, temporaryRelativePath),
      temporaryRelativePath,
    );
    if (
      !temporary.info ||
      !sameFileSnapshot(writtenInfo, temporary.info) ||
      writtenInfo.size !== BigInt(expectedBytes.byteLength) ||
      !(await readExactHandle(handle, expectedBytes.byteLength)).equals(expectedBytes)
    ) {
      throw new Error(`Generated artifact temporary bytes failed verification: ${relativePath}`);
    }
    temporaryIdentity = writtenInfo;

    const beforeRename = await inspectGeneratedArtifact(root, segments, relativePath);
    if (!destinationUnchanged(initial, beforeRename)) {
      throw new Error(`Generated artifact destination changed before rename: ${relativePath}`);
    }
    await rename(temporary.destination, beforeRename.destination);
    renamed = true;

    const installedInfo = await handle.stat({ bigint: true });
    const installed = await inspectGeneratedArtifact(root, segments, relativePath);
    if (
      !installed.info ||
      !sameFileSnapshot(installedInfo, installed.info) ||
      installedInfo.size !== BigInt(expectedBytes.byteLength) ||
      !(await readExactHandle(handle, expectedBytes.byteLength)).equals(expectedBytes)
    ) {
      throw new Error(`Generated artifact failed post-write verification: ${relativePath}`);
    }
    await syncDirectory(installed.parent);
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed && temporaryIdentity) {
      await cleanupGeneratedTemp(root, temporaryRelativePath, temporaryIdentity);
    }
  }
}

export async function writeGeneratedArtifacts(repositoryRoot, artifacts) {
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const prepared = [];
  const destinations = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object" || typeof artifact.content !== "string") {
      throw new Error("Generated artifact definition is invalid");
    }
    const segments = generatedArtifactSegments(root.path, artifact.relativePath);
    const destinationKey = segments.join("/");
    if (destinations.has(destinationKey)) {
      throw new Error("Generated artifact destinations must be unique");
    }
    destinations.add(destinationKey);
    prepared.push({
      artifact,
      initial: await inspectGeneratedArtifact(root, segments, artifact.relativePath),
    });
  }
  for (const { artifact, initial } of prepared) {
    await writeGeneratedArtifact(root, artifact.relativePath, artifact.content, initial);
  }
}

export async function verifyGeneratedArtifact(repositoryRoot, artifact) {
  if (!artifact || typeof artifact !== "object" || typeof artifact.content !== "string") {
    throw new Error("Generated artifact definition is invalid");
  }
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const segments = generatedArtifactSegments(root.path, artifact.relativePath);
  const inspected = await inspectGeneratedArtifact(root, segments, artifact.relativePath);
  if (!inspected.info) {
    throw new Error(`Generated artifact destination is missing: ${artifact.relativePath}`);
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(inspected.destination, constants.O_RDONLY | noFollow);
  try {
    const openedInfo = await handle.stat({ bigint: true });
    const openedPath = await inspectGeneratedArtifact(root, segments, artifact.relativePath);
    if (
      !openedPath.info ||
      !openedInfo.isFile() ||
      !sameFileSnapshot(openedInfo, inspected.info) ||
      !sameFileSnapshot(openedInfo, openedPath.info)
    ) {
      throw new Error(`Generated artifact changed during open: ${artifact.relativePath}`);
    }

    const expectedBytes = Buffer.from(artifact.content, "utf8");
    if (openedInfo.size !== BigInt(expectedBytes.byteLength)) {
      throw new Error(`Generated artifact bytes do not match: ${artifact.relativePath}`);
    }
    const actualBytes = await readExactHandle(handle, expectedBytes.byteLength);

    const afterReadInfo = await handle.stat({ bigint: true });
    const afterReadPath = await inspectGeneratedArtifact(root, segments, artifact.relativePath);
    if (
      !afterReadPath.info ||
      !afterReadInfo.isFile() ||
      !sameFileSnapshot(openedInfo, afterReadInfo) ||
      !sameFileSnapshot(afterReadInfo, afterReadPath.info)
    ) {
      throw new Error(`Generated artifact changed during verification: ${artifact.relativePath}`);
    }
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error(`Generated artifact bytes do not match: ${artifact.relativePath}`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function createPublicMediaVersions(configuration, repositoryRoot) {
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const versions = {};
  for (const sourcePath of publicMediaSourcePaths(configuration)) {
    const segments = publicMediaPathSegments(root.path, sourcePath);
    versions[sourcePath] = (await hashPinnedPublicMedia(root, segments, sourcePath)).digest;
  }
  return versions;
}

function normalizedPublicMediaSourcePaths(sourcePaths) {
  if (
    !sourcePaths ||
    typeof sourcePaths === "string" ||
    typeof sourcePaths[Symbol.iterator] !== "function"
  ) {
    throw new Error("Configured public media source paths are invalid");
  }
  const paths = [...sourcePaths];
  if (paths.some((sourcePath) => typeof sourcePath !== "string") || new Set(paths).size !== paths.length) {
    throw new Error("Configured public media source paths are invalid or duplicated");
  }
  return paths.sort();
}

export function validatePublicMediaVersionMap(sourcePaths, mediaVersions) {
  if (
    !mediaVersions ||
    typeof mediaVersions !== "object" ||
    Array.isArray(mediaVersions) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(mediaVersions))
  ) {
    throw new Error("Generated public media versions are missing or invalid");
  }
  const expectedPaths = normalizedPublicMediaSourcePaths(sourcePaths);
  const generatedPaths = Object.keys(mediaVersions).sort();
  if (
    generatedPaths.length !== expectedPaths.length ||
    generatedPaths.some((sourcePath, index) => sourcePath !== expectedPaths[index])
  ) {
    throw new Error("Generated public media versions do not match configured public assets");
  }
  for (const sourcePath of expectedPaths) {
    if (typeof mediaVersions[sourcePath] !== "string" || !SHA256_PATTERN.test(mediaVersions[sourcePath])) {
      throw new Error(`Public media asset lacks a generated SHA-256 version: ${sourcePath}`);
    }
  }
  return expectedPaths;
}

export function validatePublicMediaVersions(configuration, mediaVersions) {
  return validatePublicMediaVersionMap(publicMediaSourcePaths(configuration), mediaVersions);
}

export async function validatePublicMediaRoot({ mediaVersions, root: rootPath, sourcePaths }) {
  const expectedPaths = validatePublicMediaVersionMap(sourcePaths, mediaVersions);
  const root = await canonicalRepositoryRoot(rootPath);
  const snapshots = new Map();
  for (const sourcePath of expectedPaths) {
    const segments = publicMediaPathSegments(root.path, sourcePath);
    const validated = await hashPinnedPublicMedia(root, segments, sourcePath);
    if (validated.digest !== mediaVersions[sourcePath]) {
      throw new Error(
        `Public media bytes do not match the generated SHA-256 version: ${sourcePath}`,
      );
    }
    snapshots.set(sourcePath, validated.snapshot);
  }
  return snapshots;
}

function versionedRelativeUrl(sourcePath, mediaVersions) {
  const version = mediaVersions[sourcePath];
  if (!SHA256_PATTERN.test(version)) {
    throw new Error(`Public media asset lacks a generated SHA-256 version: ${sourcePath}`);
  }
  return `${encodeRelativePath(sourcePath)}?v=${version}`;
}

export function createPublicPortfolioManifest(configuration, mediaVersions) {
  validatePublicMediaVersions(configuration, mediaVersions);
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
            url: versionedRelativeUrl(item.sourcePath, mediaVersions),
            ...(item.posterPath
              ? { poster: versionedRelativeUrl(item.posterPath, mediaVersions) }
              : {}),
          };
        }),
      };
    }),
  };
}

export function serializePublicMediaVersions(mediaVersions) {
  const sortedVersions = Object.fromEntries(
    Object.entries(mediaVersions).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return `${JSON.stringify(sortedVersions, null, 2)}\n`;
}

export function serializePublicPortfolioManifest(configuration, mediaVersions) {
  return `${JSON.stringify(createPublicPortfolioManifest(configuration, mediaVersions), null, 2)}\n`;
}
