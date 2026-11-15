import type { PoolClient } from 'pg';
import { FORM_FILE_LIMITS } from '@pertexo/workflow-model';
import { FormUploadLimitError } from './form-upload.errors.js';
import { lockUnsentPublicBytes } from './unsent.repository.js';

/**
 * Anyone with a public link can upload without ever sending the form, so those
 * files get their own small allowance instead of the whole workspace quota.
 * Begins wait on one workspace lock, so concurrent responders can't overshoot.
 */
export async function assertUnsentPublicRoom(
  client: PoolClient,
  workspaceId: string,
  byteLength: number,
): Promise<void> {
  const held = await lockUnsentPublicBytes(client, workspaceId);
  if (held + byteLength > FORM_FILE_LIMITS.unsentPublicBytes)
    throw new FormUploadLimitError('unsent_public');
}
