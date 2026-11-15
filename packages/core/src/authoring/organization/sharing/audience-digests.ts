import { WORKFLOW_FOLDER_LIMITS } from '@pertexo/workflow-model';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/database/primitives';
import { FOLDER_GRANT_LIMIT } from '@pertexo/workflow-model';

/** Each folder fits 1 KiB, including its name; one more reserves the envelope. */
const FOLDER_AUDIENCE_ENTRY_BYTES = 1024;
/** The largest principal carries two UUIDs and its access level, without display labels. */
const FOLDER_GRANT_ENTRY_BYTES = 256;

export function folderAudienceFingerprint(value: unknown): string {
  return digest(
    value,
    (WORKFLOW_FOLDER_LIMITS.foldersPerWorkspace + 1) *
      FOLDER_AUDIENCE_ENTRY_BYTES,
    'folder audience',
  );
}

export function folderGrantDigest(value: unknown): string {
  return digest(
    value,
    FOLDER_GRANT_LIMIT * FOLDER_GRANT_ENTRY_BYTES,
    'folder grants',
  );
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
