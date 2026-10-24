import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { previewRuns, previewAttempts } from '../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import {
  PreviewAttemptStateError,
  previewPairConsistent,
  type PreviewAttemptLease,
} from '../contract.js';

export async function lockPreviewReconciliationState(
  client: PoolClient,
  scope: Pick<
    PreviewAttemptLease,
    'workspaceId' | 'previewAttemptId' | 'previewRunId'
  >,
) {
  const attempt = alias(previewAttempts, 'attempt');
  const run = alias(previewRuns, 'run');
  const locked = await drizzle(client)
    .select({
      attemptStatus: attempt.status,
      dispatchMarkedAt: attempt.dispatchMarkedAt,
      fenceToken: attempt.fenceToken,
      leaseExpiresAt: attempt.leaseExpiresAt,
      leaseLive: sql<boolean>`(${attempt.leaseExpiresAt} is not null and ${attempt.leaseExpiresAt}>clock_timestamp())`,
      sideEffectClass: attempt.sideEffectClass,
      mayContactProvider: run.mayContactProvider,
      mayCauseExternalSideEffect: run.mayCauseExternalSideEffect,
      operationKey: run.operationKey,
      providerKey: run.providerKey,
      usesConnection: sql<boolean>`coalesce(jsonb_typeof(${run.executableNodeJson}::jsonb->'connectionRefs')='object' and ${run.executableNodeJson}::jsonb->'connectionRefs'<>'{}'::jsonb,false)`,
      runStatus: run.status,
      runDeadlineExpired: sql<boolean>`${run.executionDeadlineAt}<=clock_timestamp()`,
    })
    .from(attempt)
    .innerJoin(
      run,
      and(
        eq(run.workspaceId, attempt.workspaceId),
        eq(run.id, attempt.previewRunId),
      ),
    )
    .where(
      and(
        eq(attempt.workspaceId, scope.workspaceId),
        eq(attempt.id, scope.previewAttemptId),
        eq(attempt.previewRunId, scope.previewRunId),
      ),
    )
    .for('update', { of: [attempt, run] })
    .catch(rethrowQueryFailure);
  const state = locked[0];
  if (state === undefined)
    throw new PreviewAttemptStateError('attempt_not_found');
  if (!previewPairConsistent(state.attemptStatus, state.runStatus))
    throw new PreviewAttemptStateError('run_attempt_divergence');

  return state;
}
