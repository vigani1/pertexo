import type { PoolClient } from 'pg';
import {
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
} from '../../shared/command-receipt.errors.js';
import { IDEMPOTENCY_STATUS } from '@pertexo/database/primitives';
import type { WorkspaceCreationResult } from '../tenant-access.types.js';
import {
  insertCreationClaim,
  parseDurableWorkspaceResult,
  readCreationRecord,
} from './creation-receipt.repository.js';

type CommandClaim =
  | Readonly<{ claimed: true; id: string }>
  | Readonly<{ claimed: false; result: WorkspaceCreationResult }>;

export async function claimWorkspaceCreationCommand(
  client: PoolClient,
  actorUserId: string,
  keyHash: string,
  requestHash: string,
): Promise<CommandClaim> {
  const key = { actorUserId, keyHash, requestHash };
  const insertedId = await insertCreationClaim(client, key);
  if (insertedId !== undefined) return { claimed: true, id: insertedId };

  const row = await readCreationRecord(client, key);
  if (row === undefined) throw new IdempotencyRecordCorruptError();
  if (row.requestHash !== requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  if (row.status !== IDEMPOTENCY_STATUS.completed) {
    throw new IdempotencyRecordCorruptError();
  }
  return {
    claimed: false,
    result: parseDurableWorkspaceResult(row.resultRef),
  };
}
