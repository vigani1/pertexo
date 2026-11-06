import type { Pool } from 'pg';
import { generatePersistedId } from '@pertexo/database/platform';
import {
  commandKeyHash,
  commandRequestHash,
} from '../../shared/command-fingerprints.js';
import { throwWorkspaceLifecycleError } from '../workspace-lifecycle.errors.js';
import { changeWorkspaceLifecycle } from './change.js';
import type {
  RequestWorkspaceLifecycleOperationInput,
  WorkspaceLifecycleOperation,
} from './workspace-lifecycle.types.js';

export async function requestWorkspaceLifecycleOperation(
  pool: Pool,
  input: RequestWorkspaceLifecycleOperationInput,
): Promise<WorkspaceLifecycleOperation> {
  const workspaceId = input.workspaceId;
  const actorUserId = input.actorUserId;
  const commandType = input.commandType;
  const reason = input.reason;
  try {
    return await changeWorkspaceLifecycle(pool, {
      operationId: generatePersistedId(),
      workspaceId,
      actorUserId,
      commandType,
      reason,
      idempotencyKeyHash: commandKeyHash(input.idempotencyKey),
      requestHash: commandRequestHash({
        actorUserId,
        commandType,
        reason,
        workspaceId,
      }),
    });
  } catch (error: unknown) {
    throwWorkspaceLifecycleError(error);
  }
}
