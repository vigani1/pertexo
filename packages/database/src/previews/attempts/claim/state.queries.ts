import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import {
  previewAttempts,
  previewRuns,
} from '../../../schema/runs/execution.js';
import { readVariableSetValues } from '../../../variables/values.queries.js';
import { executableNodeSchema } from '../../executable-node.js';

import type { PreviewAttemptLease } from '../../contract.js';
import { PreviewAttemptStateError } from '../../errors.js';
import { previewPairConsistent } from '../../state.js';

import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import type { withTenantScopedClient } from '../../../tenant-access/transactions.js';

export async function loadPreviewLease(
  client: Parameters<Parameters<typeof withTenantScopedClient>[2]>[0],
  input: Readonly<{
    attemptFenceToken: number;
    previewAttemptId: string;
    previewRunId: string;
    workspaceId: string;
  }>,
): Promise<PreviewAttemptLease> {
  const db = drizzle(client);
  const prior = alias(previewRuns, 'prior');
  const runs = await db
    .select({
      definitionKey: previewRuns.definitionKey,
      definitionVersion: previewRuns.definitionVersion,
      dryRun: previewRuns.dryRun,
      executableNodeJson: previewRuns.executableNodeJson,
      executorKey: previewRuns.executorKey,
      executorVersion: previewRuns.executorVersion,
      inputRef: previewRuns.inputRef,
      priorPreviewNodeId: prior.nodeId,
      variableSetRevision: previewRuns.variableSetRevision,
      mayContactProvider: previewRuns.mayContactProvider,
      mayCauseExternalSideEffect: previewRuns.mayCauseExternalSideEffect,
      nodeId: previewRuns.nodeId,
      operationKey: previewRuns.operationKey,
      providerKey: previewRuns.providerKey,
      traceparent: previewRuns.traceparent,
      workflowId: previewRuns.workflowId,
      executionDeadlineAt: previewRuns.executionDeadlineAt,
      retentionExpiresAt: previewRuns.expiresAt,
    })
    .from(previewRuns)
    .leftJoin(
      prior,
      and(
        eq(prior.workspaceId, previewRuns.workspaceId),
        eq(prior.workflowId, previewRuns.workflowId),
        eq(prior.id, previewRuns.priorPreviewRunId),
      ),
    )
    .where(
      and(
        eq(previewRuns.workspaceId, input.workspaceId),
        eq(previewRuns.id, input.previewRunId),
      ),
    )
    .catch(rethrowQueryFailure);
  const attempts = await db
    .select({
      dispatchMarkedAt: previewAttempts.dispatchMarkedAt,
      providerDispatchBinding: previewAttempts.providerDispatchBinding,
      providerIdempotencyKey: previewAttempts.providerIdempotencyKey,
      sideEffectClass: previewAttempts.sideEffectClass,
    })
    .from(previewAttempts)
    .where(
      and(
        eq(previewAttempts.workspaceId, input.workspaceId),
        eq(previewAttempts.id, input.previewAttemptId),
      ),
    )
    .catch(rethrowQueryFailure);
  const run = runs[0];
  const attempt = attempts[0];
  if (run === undefined || attempt === undefined)
    throw new PreviewAttemptStateError('pins_missing');
  const {
    executableNodeJson,
    inputRef,
    priorPreviewNodeId,
    variableSetRevision,
    operationKey,
    providerKey,
    traceparent,
    ...identity
  } = run;
  return Object.freeze({
    ...identity,
    // Native bigint decoding still needs the public lease's safe integer bound.
    attemptFenceToken: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(input.attemptFenceToken),
    workspaceId: input.workspaceId,
    executableNode: Object.freeze(
      executableNodeSchema.parse(executableNodeJson),
    ),
    input: parseStoredExecutionValue(inputRef),
    ...(priorPreviewNodeId === null ? {} : { priorPreviewNodeId }),
    variables: await readVariableSetValues(
      db,
      input.workspaceId,
      variableSetRevision,
    ),
    ...(operationKey === null ? {} : { operationKey }),
    previewAttemptId: input.previewAttemptId,
    previewRunId: input.previewRunId,
    ...(providerKey === null ? {} : { providerKey }),
    ...(attempt.providerIdempotencyKey === null
      ? {}
      : { providerIdempotencyKey: attempt.providerIdempotencyKey }),
    ...(attempt.providerDispatchBinding === null
      ? {}
      : { providerDispatchBinding: attempt.providerDispatchBinding }),
    ...(attempt.dispatchMarkedAt === null
      ? {}
      : { providerDispatchUnresolved: true as const }),
    sideEffectClass: attempt.sideEffectClass,
    ...(traceparent === null ? {} : { traceparent }),
  });
}

export async function lockPreviewClaimState(
  client: PoolClient,
  parsed: Pick<
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
      sideEffectClass: attempt.sideEffectClass,
      liveLease: sql<boolean>`${attempt.leaseExpiresAt} is not null and ${attempt.leaseExpiresAt}>clock_timestamp()`,
      runDeadlineExpired: sql<boolean>`${run.executionDeadlineAt}<=clock_timestamp()`,
      runStatus: run.status,
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
        eq(attempt.workspaceId, parsed.workspaceId),
        eq(attempt.id, parsed.previewAttemptId),
        eq(attempt.previewRunId, parsed.previewRunId),
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
