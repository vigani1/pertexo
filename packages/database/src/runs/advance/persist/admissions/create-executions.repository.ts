import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { nodeRuns, nodeAttempts } from '../../../../schema/runs/execution.js';
import { outboxEvents } from '../../../../schema/transport.js';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../contract.js';

import type { RunTransitionPlan } from '../../plan.js';
import { canonicalOutboxPayloadChecksum } from '../../../../outbox/events.repository.js';
import { serializeStoredExecutionJsonValue } from '../../../../platform/stored-execution-value.js';
import type { ExecutionIdentityMap } from './contract.js';

export async function persistNodeAdmissions(
  client: PoolClient,
  plan: RunTransitionPlan,
  workspaceId: string,
  runId: string,
): Promise<ExecutionIdentityMap> {
  const invocations = new Map(
    [...plan.checkpoint.invocations, ...(plan.prunedInvocations ?? [])].map(
      (invocation) => [invocation.invocationKey, invocation],
    ),
  );
  const attempts = new Map(
    plan.attempts.map((attempt) => [attempt.invocationKey, attempt]),
  );
  const physical: ExecutionIdentityMap = new Map();
  const rows: PgInsertValue<typeof nodeRuns>[] = [];
  for (const admission of plan.nodeRunAdmissions) {
    const invocation = invocations.get(admission.invocationKey);
    if (invocation === undefined) throw new CoordinatorRunStateCorruptError();
    const attempt = attempts.get(admission.invocationKey);
    const nodeRunId = generatePersistedId();
    const attemptId = attempt === undefined ? undefined : generatePersistedId();
    const status = admittedNodeStatus(invocation);
    rows.push({
      id: nodeRunId,
      workspaceId,
      workflowRunId: runId,
      nodeId: admission.nodeId,
      invocationKey: admission.invocationKey,
      branchContext: sql`${serializeStoredExecutionJsonValue({
        ...(invocation.branchPath === undefined
          ? {}
          : { branchPath: invocation.branchPath }),
        ...(invocation.iterationPath === undefined
          ? {}
          : { iterationPath: invocation.iterationPath }),
      })}::jsonb`,
      status,
      completedAt: status === 'skipped' ? sql`clock_timestamp()` : null,
      sideEffectClass: admission.sideEffectClass,
      providerIdempotencyKey: admission.providerIdempotencyKey ?? null,
      currentAttemptId: attemptId ?? null,
      currentAttemptNumber: attempt?.attemptNumber ?? null,
    });
    physical.set(admission.invocationKey, {
      nodeRunId,
      ...(attemptId === undefined || attempt === undefined
        ? {}
        : { attemptId, attemptNumber: attempt.attemptNumber }),
    });
  }
  if (rows.length > 0) {
    const inserted = await drizzle(client)
      .insert(nodeRuns)
      .values(rows)
      .catch(rethrowQueryFailure);
    if (inserted.rowCount !== rows.length)
      throw new CoordinatorRunStateCorruptError();
  }
  return physical;
}

export async function persistAttemptAdmissions(
  client: PoolClient,
  input: Readonly<{
    physical: ExecutionIdentityMap;
    plan: RunTransitionPlan;
    runId: string;
    traceparent?: string;
    workspaceId: string;
  }>,
): Promise<void> {
  const { physical, plan, runId, traceparent, workspaceId } = input;
  const attemptRows: PgInsertValue<typeof nodeAttempts>[] = [];
  const outboxRows: PgInsertValue<typeof outboxEvents>[] = [];
  for (const attempt of plan.attempts) {
    let ids = physical.get(attempt.invocationKey);
    if (ids === undefined) {
      const [node] = await drizzle(client)
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.workspaceId, workspaceId),
            eq(nodeRuns.workflowRunId, runId),
            eq(nodeRuns.invocationKey, attempt.invocationKey),
          ),
        )
        .for('update')
        .catch(rethrowQueryFailure);
      if (node === undefined) throw new CoordinatorRunStateCorruptError();
      ids = {
        nodeRunId: node.id,
        attemptId: generatePersistedId(),
        attemptNumber: attempt.attemptNumber,
      };
      physical.set(attempt.invocationKey, ids);
      // A retry resolves and records its own input (ADR 052), so it starts
      // without its predecessor's. A resumed wait receives none: the input
      // its step received stays.
      await drizzle(client)
        .update(nodeRuns)
        .set({
          status: 'ready',
          currentAttemptId: ids.attemptId,
          currentAttemptNumber: attempt.attemptNumber,
          resumeAt: null,
          retryDueAt: null,
          dueWakeupAt: null,
          waitKind: null,
          inputRef:
            attempt.admissionKind === 'wait_resume' ? nodeRuns.inputRef : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(nodeRuns.workspaceId, workspaceId),
            eq(nodeRuns.id, ids.nodeRunId),
          ),
        )
        .catch(rethrowQueryFailure);
    }
    if (ids.attemptId === undefined)
      throw new CoordinatorRunStateCorruptError();
    attemptRows.push({
      id: ids.attemptId,
      workspaceId,
      status: 'ready',
      nodeRunId: ids.nodeRunId,
      attemptNumber: attempt.attemptNumber,
      sideEffectClass: attempt.sideEffectClass,
      providerIdempotencyKey: attempt.providerIdempotencyKey ?? null,
      admissionKind: attempt.admissionKind,
    });
    const outboxEventId = generatePersistedId();
    const payload = {
      workspaceId,
      runId,
      nodeRunId: ids.nodeRunId,
      attemptId: ids.attemptId,
      outboxEventId,
      ...(traceparent === undefined ? {} : { traceparent }),
    } as const;
    outboxRows.push({
      id: outboxEventId,
      workspaceId,
      jobName: 'execute-node-attempt',
      aggregateType: 'node-attempt',
      aggregateId: ids.attemptId,
      payload: sql`${serializeStoredExecutionJsonValue(payload)}::jsonb`,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    });
  }
  if (attemptRows.length > 0) {
    const insertedAttempts = await drizzle(client)
      .insert(nodeAttempts)
      .values(attemptRows)
      .catch(rethrowQueryFailure);
    if (insertedAttempts.rowCount !== attemptRows.length)
      throw new CoordinatorRunStateCorruptError();
    const insertedOutbox = await drizzle(client)
      .insert(outboxEvents)
      .values(outboxRows)
      .catch(rethrowQueryFailure);
    if (insertedOutbox.rowCount !== outboxRows.length)
      throw new CoordinatorRunStateCorruptError();
  }
}

function admittedNodeStatus(
  invocation: RunTransitionPlan['checkpoint']['invocations'][number],
): 'pending' | 'skipped' | 'ready' {
  if (invocation.status === 'pending') {
    return 'pending';
  }
  if (invocation.status === 'skipped') {
    return 'skipped';
  }
  return 'ready';
}
