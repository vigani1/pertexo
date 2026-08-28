import type { Pool } from 'pg';
import { z } from 'zod';

import {
  PreviewAttemptStateError,
  optionsFor,
  type PreviewAttemptLease,
} from './preview-execution-contract.js';
import { withTenantScopedClient } from './workspace.js';

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
      const result = await client.query<{ attempt_lease_expires_at: Date }>(
        `update app.preview_attempts
         set lease_expires_at=clock_timestamp() + ($5::int * interval '1 second'),
             updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2 and preview_run_id=$3
           and status='running' and lease_owner=$4 and fence_token=$6
         returning lease_expires_at as attempt_lease_expires_at`,
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
      const runs = await client.query<{ execution_deadline_at: Date }>(
        `select execution_deadline_at from app.preview_runs
         where workspace_id=$1 and id=$2`,
        [scope.workspaceId, scope.previewRunId],
      );
      const runRow = runs.rows[0];
      if (runRow === undefined)
        throw new PreviewAttemptStateError('run_missing');
      return Object.freeze({
        attemptLeaseExpiresAt: row.attempt_lease_expires_at,
        runExecutionDeadlineAt: runRow.execution_deadline_at,
      });
    },
    optionsFor(input.signal),
  );
}
