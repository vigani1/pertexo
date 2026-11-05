import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/database/primitives';
import { FOLDER_GRANT_LIMIT } from '@pertexo/workflow-model';
import { FOLDER_LIMIT } from '../../../shared/folder-policy.js';

export function folderAudienceFingerprint(value: unknown): string {
  // Each folder fits 1 KiB, including a 128-byte name; reserve the envelope too.
  return digest(value, (FOLDER_LIMIT + 1) * 1024, 'folder audience');
}

export function folderGrantDigest(value: unknown): string {
  // The largest principal carries two UUIDs and its access level, without display labels.
  return digest(value, FOLDER_GRANT_LIMIT * 256, 'folder grants');
}

function digest(value: unknown, maximumBytes: number, label: string): string {
  // Preserve the existing canonical bytes so already-issued review tokens remain valid.
  return createHash('sha256')
    .update(
      canonicalJson(value, maximumBytes, {
        maximumDatabaseBytes: maximumBytes,
        label,
      }),
    )
    .digest('hex');
}
