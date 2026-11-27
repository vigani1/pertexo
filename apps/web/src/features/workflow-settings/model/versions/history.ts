import type { WorkflowVersionResponse } from '@pertexo/contracts';

/** A published version as the history lists it, with who published it. */
export type HistoryVersion = WorkflowVersionResponse &
  Readonly<{
    graphDigest: string;
    publishedBy: Exclude<WorkflowVersionResponse['publishedBy'], undefined>;
  }>;

export function publisherLabel(version: HistoryVersion): string {
  return version.publishedBy?.displayName ?? 'A former member';
}

/** The version shown first: the chosen one, else the live one, else the newest. */
export function shownVersion(
  versions: readonly HistoryVersion[],
  chosenId: string | undefined,
  liveVersionId: string | null,
): HistoryVersion | undefined {
  return (
    versions.find((version) => version.id === chosenId) ??
    versions.find((version) => version.id === liveVersionId) ??
    versions[0]
  );
}

/** The version published just before this one, if any (newest-first list). */
export function previousVersion(
  versions: readonly HistoryVersion[],
  version: HistoryVersion,
): HistoryVersion | undefined {
  return versions.find(
    (candidate) => candidate.versionNumber < version.versionNumber,
  );
}

/** The first twelve hex digits of a checksum, in fours: “9c1e·44ab·07f2”. */
export function shortChecksum(checksum: string): string {
  const hex = checksum.replace(/^wf:sha256:(?:v2:)?/u, '').slice(0, 12);
  return hex.match(/.{1,4}/gu)?.join('·') ?? hex;
}
