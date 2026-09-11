import type {
  DeleteObjectsCommandOutput,
  ListObjectVersionsCommandOutput,
  ObjectIdentifier,
} from '@aws-sdk/client-s3';

import { ArtifactIntegrityError } from './artifact-errors.js';

export type WorkspaceVersionEntry =
  | NonNullable<ListObjectVersionsCommandOutput['Versions']>[number]
  | NonNullable<ListObjectVersionsCommandOutput['DeleteMarkers']>[number];

export function assertWorkspaceVersionListing(
  listed: ListObjectVersionsCommandOutput,
  entries: readonly WorkspaceVersionEntry[],
  maxObjects: number,
): void {
  if (entries.length > maxObjects) {
    throw new ArtifactIntegrityError(
      'Object version listing exceeded the requested page bound',
    );
  }
  if (entries.length === 0 && listed.IsTruncated === true) {
    throw new ArtifactIntegrityError(
      'Object version listing was truncated without entries',
    );
  }
}

export function workspaceVersionDeleteObjects(
  entries: readonly WorkspaceVersionEntry[],
  prefix: string,
  identities: Set<string>,
): ObjectIdentifier[] {
  return entries.map((entry) => {
    if (
      typeof entry.Key !== 'string' ||
      !entry.Key.startsWith(prefix) ||
      typeof entry.VersionId !== 'string' ||
      entry.VersionId.length === 0
    ) {
      throw new ArtifactIntegrityError(
        'Object version listing contained an invalid workspace entry',
      );
    }
    const identity = `${entry.Key}\u0000${entry.VersionId}`;
    if (identities.has(identity)) {
      throw new ArtifactIntegrityError(
        'Object version listing contained a duplicate entry',
      );
    }
    identities.add(identity);
    return { Key: entry.Key, VersionId: entry.VersionId };
  });
}

export function validateWorkspaceVersionDeletion(
  deleted: DeleteObjectsCommandOutput,
  requestedIdentities: ReadonlySet<string>,
  requestedCount: number,
): number {
  if ((deleted.Errors?.length ?? 0) > 0) {
    throw new ArtifactIntegrityError(
      'Object version deletion reported one or more failures',
    );
  }
  const acknowledged = deleted.Deleted;
  if (acknowledged?.length !== requestedCount)
    throw new ArtifactIntegrityError(
      'Object version deletion acknowledgements were incomplete',
    );
  const acknowledgedIdentities = new Set<string>();
  for (const entry of acknowledged) {
    if (typeof entry.Key !== 'string' || typeof entry.VersionId !== 'string')
      throw new ArtifactIntegrityError(
        'Object version deletion acknowledgement was malformed',
      );
    const identity = `${entry.Key}\u0000${entry.VersionId}`;
    if (
      !requestedIdentities.has(identity) ||
      acknowledgedIdentities.has(identity)
    )
      throw new ArtifactIntegrityError(
        'Object version deletion acknowledgement did not match the request',
      );
    acknowledgedIdentities.add(identity);
  }
  return acknowledgedIdentities.size;
}
