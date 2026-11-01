import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { previewAttempts, previewRuns } from '@pertexo/database/schema';
import type { PreviewHeartbeatResult } from './contract.js';

import type { PreviewAttemptLease } from '../contract.js';
import { PreviewAttemptStateError } from '../errors.js';
import { optionsFor } from '../input.js';

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
  const scope = {
    ...input.lease,
    leaseDurationSeconds: input.leaseDurationSeconds,
    workerId: input.workerId,
  };
  return withTenantScopedClient(
    pool,
    { workspaceId: scope.workspaceId },
    async (client) => {
      const result = await drizzle(client)
        .update(previewAttempts)
        .set({
          leaseExpiresAt: sql`least(clock_timestamp()+(${scope.leaseDurationSeconds}::int*interval '1 second'),${previewRuns.executionDeadlineAt})`,
          updatedAt: sql`clock_timestamp()`,
        })
        .from(previewRuns)
        .where(
          and(
            eq(previewAttempts.workspaceId, scope.workspaceId),
            eq(previewAttempts.id, scope.previewAttemptId),
            eq(previewAttempts.previewRunId, scope.previewRunId),
            eq(previewAttempts.status, 'running'),
            eq(previewAttempts.leaseOwner, scope.workerId),
            eq(previewAttempts.fenceToken, scope.attemptFenceToken),
            sql`${previewAttempts.leaseExpiresAt}>clock_timestamp()`,
            eq(previewRuns.workspaceId, previewAttempts.workspaceId),
            eq(previewRuns.id, previewAttempts.previewRunId),
            sql`${previewRuns.executionDeadlineAt}>clock_timestamp()`,
          ),
        )
        .returning({
          attemptLeaseExpiresAt:
            sql<Date>`${previewAttempts.leaseExpiresAt}`.mapWith(
              previewAttempts.leaseExpiresAt,
            ),
          runExecutionDeadlineAt: previewRuns.executionDeadlineAt,
        })
        .catch(rethrowQueryFailure);
      const row = result[0];
      if (row === undefined)
        throw new PreviewAttemptStateError('heartbeat_lost');
      return Object.freeze({
        attemptLeaseExpiresAt: row.attemptLeaseExpiresAt,
        runExecutionDeadlineAt: row.runExecutionDeadlineAt,
      });
    },
    optionsFor(input.signal),
  );
}
