export interface PublicMediaFileSnapshot {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
}

export function validatePublicMediaRoot(options: {
  mediaVersions: Readonly<Record<string, unknown>>;
  root: string;
  sourcePaths: Iterable<string>;
}): Promise<ReadonlyMap<string, PublicMediaFileSnapshot>>;
