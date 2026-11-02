import { lockWorkspaceRunAdmission } from '../../admission-locks.queries.js';
import { postgresFailure } from '@pertexo/database/primitives';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';

import {
  WorkspaceRunAdmissionDeniedError,
  WorkspaceRunQuotaExceededError,
} from './errors.js';

/** Operation-local SQLSTATE mapping for queued workflow-run admission. */
export function throwWorkflowRunAdmissionError(error: unknown): never {
  const { code } = postgresFailure(error);
  if (code === 'PTA02') throw new WorkspaceRunQuotaExceededError();
  if (code === 'PTA01') throw new WorkspaceRunAdmissionDeniedError();
  throw error;
}

export async function assertWorkspaceAcceptsNewRuns(
  transaction: WorkspaceTransaction,
): Promise<void> {
  const status = await lockWorkspaceRunAdmission(
    transaction.db,
    transaction.workspaceId,
  );
  if (status !== 'active') throw new WorkspaceRunAdmissionDeniedError();
}
