import type { Pool } from 'pg';
import { z } from 'zod';

import {
  PreviewAttemptStateError,
  optionsFor,
  type PreviewAttemptLease,
} from './preview-execution-contract.js';
import { withTenantScopedClient } from '../tenant-access/workspace.js';

export type PreviewHeartbeatResult = Readonly<{
  attemptLeaseExpiresAt: Date;
  runExecutionDeadlineAt: Date;
}>;

export async function heartbeatPreviewLease(
  pool: Pool,
  input: Readonly<{
    lease: Pick<
      PreviewAttemptLease,
      'attemptFenceToken' | 'previewAttemptId' | 'previewRunId' | 'workspaceId'
    >;
    leaseDurationSeconds: number;
    signal?: AbortSignal;
    workerId: string;
  }>,
): Promise<PreviewHeartbeatResult> {
  const scope = z
    .object({
      attemptFenceToken: z.number().int().nonnegative(),
      leaseDurationSeconds: z.number().int().positive().max(3_600),
      previewAttemptId: z.uuid(),
      previewRunId: z.uuid(),
      workerId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      workspaceId: z.uuid(),
    })
    .parse({
      ...input.lease,
      leaseDurationSeconds: input.leaseDurationSeconds,
      workerId: input.workerId,
    });
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client) => {
      const result = await client.query<{
        attempt_lease_expires_at: Date;
        execution_deadline_at: Date;
      }>(
        `update app.preview_attempts
         set lease_expires_at=least(
               clock_timestamp() + ($5::int * interval '1 second'),
               run.execution_deadline_at
             ),
             updated_at=clock_timestamp()
         from app.preview_runs run
         where preview_attempts.workspace_id=$1
           and preview_attempts.id=$2
           and preview_attempts.preview_run_id=$3
           and preview_attempts.status='running'
           and preview_attempts.lease_owner=$4
           and preview_attempts.fence_token=$6
           and preview_attempts.lease_expires_at > clock_timestamp()
           and run.workspace_id=preview_attempts.workspace_id
           and run.id=preview_attempts.preview_run_id
           and run.execution_deadline_at > clock_timestamp()
         returning preview_attempts.lease_expires_at
                     as attempt_lease_expires_at,
                   run.execution_deadline_at`,
        [
          scope.workspaceId,
          scope.previewAttemptId,
          scope.previewRunId,
          scope.workerId,
          scope.leaseDurationSeconds,
          scope.attemptFenceToken,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new PreviewAttemptStateError('heartbeat_lost');
      return Object.freeze({
        attemptLeaseExpiresAt: row.attempt_lease_expires_at,
        runExecutionDeadlineAt: row.execution_deadline_at,
      });
    },
    optionsFor(input.signal),
  );
}
