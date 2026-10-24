import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { previewRuns, previewAttempts } from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  PreviewAttemptStateError,
  optionsFor,
  type PreviewAttemptLease,
} from '../contract.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';

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
