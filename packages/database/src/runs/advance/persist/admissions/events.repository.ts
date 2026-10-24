import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { nodeRuns, runEvents } from '../../../../schema/runs/execution.js';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../../state-errors.js';
import type { PendingCoordinatorFailure } from '../../load/state.queries.js';
import { terminalStatus } from '../../load/event-facts.queries.js';
import type { RunTransitionPlan } from '../../plan.js';

import { serializeStoredExecutionJsonValue } from '../../../../platform/stored-execution-value.js';
import type { ExecutionIdentityMap } from './contract.js';

export async function loadEventExecutionIdentities(
  client: PoolClient,
  physical: ExecutionIdentityMap,
  {
    plan,
    workspaceId,
    runId,
  }: Readonly<{ plan: RunTransitionPlan; workspaceId: string; runId: string }>,
): Promise<void> {
  const missingInvocationKeys = [
    ...new Set(
      plan.events.flatMap(({ invocationKey }) =>
        invocationKey === undefined || physical.has(invocationKey)
          ? []
          : [invocationKey],
      ),
    ),
  ];
  if (missingInvocationKeys.length === 0) return;
  const n = nodeRuns;
  const existingNodes = await drizzle(client)
    .select({
      id: n.id,
      invocation_key: n.invocationKey,
      current_attempt_id: n.currentAttemptId,
      current_attempt_number: n.currentAttemptNumber,
    })
    .from(n)
    .where(
      and(
        eq(n.workspaceId, workspaceId),
        eq(n.workflowRunId, runId),
        inArray(n.invocationKey, missingInvocationKeys),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  for (const node of existingNodes)
    physical.set(node.invocation_key, {
      nodeRunId: node.id,
      ...(node.current_attempt_id === null
        ? {}
        : {
            attemptId: node.current_attempt_id,
            ...(node.current_attempt_number === null
              ? {}
              : { attemptNumber: node.current_attempt_number }),
          }),
    });
  if (missingInvocationKeys.some((key) => !physical.has(key)))
    throw new CoordinatorRunStateCorruptError();
}

export async function persistRunEvents(
  client: PoolClient,
  input: Readonly<{
    pendingFailures: readonly PendingCoordinatorFailure[];
    physical: ExecutionIdentityMap;
    plan: RunTransitionPlan;
    runId: string;
    workspaceId: string;
    rejectedForEachDeclarations: ReadonlySet<string>;
  }>,
): Promise<void> {
  const { pendingFailures, physical, plan, runId, workspaceId } = input;
  const pendingFailureInvocations = new Set(
    pendingFailures.map(({ invocation_key: invocationKey }) => invocationKey),
  );
  const persistedEvents = plan.events.map((event) => {
    const ids =
      event.invocationKey === undefined
        ? undefined
        : physical.get(event.invocationKey);
    const payload = {
      ...(event.invocationKey === undefined
        ? {}
        : { invocationKey: event.invocationKey }),
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      ...(event.attemptNumber === undefined
        ? {}
        : { attemptNumber: event.attemptNumber }),
      ...(event.reasonCode === undefined
        ? {}
        : { reasonCode: event.reasonCode }),
      ...(event.dueAt === undefined ? {} : { dueAt: event.dueAt }),
      ...(ids === undefined ? {} : { nodeRunId: ids.nodeRunId }),
      ...(ids?.attemptId !== undefined &&
      ids.attemptNumber === event.attemptNumber
        ? { attemptId: ids.attemptId }
        : {}),
    };
    return {
      workspaceId,
      workflowRunId: runId,
      sequence: event.sequence,
      type: event.name,
      payload: sql`${serializeStoredExecutionJsonValue(payload)}::jsonb`,
      createdAt: sql`${event.occurredAt}::timestamptz`,
    };
  });
  await insertEvents(client, persistedEvents);
  for (const event of plan.events) {
    const terminalNodeStatus = terminalStatus(event.name);
    const settlesInvocation =
      terminalNodeStatus !== undefined &&
      event.invocationKey !== undefined &&
      !pendingFailureInvocations.has(event.invocationKey) &&
      !input.rejectedForEachDeclarations.has(event.invocationKey);
    if (settlesInvocation) {
      const n = nodeRuns;
      const updatedNode = await drizzle(client)
        .update(n)
        .set({
          status: terminalNodeStatus,
          completedAt: sql`clock_timestamp()`,
          safeErrorCode: event.reasonCode ?? null,
          resumeAt: null,
          retryDueAt: null,
          dueWakeupAt: null,
          controlKind: null,
          waitKind: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(n.workspaceId, workspaceId),
            eq(n.workflowRunId, runId),
            eq(n.invocationKey, event.invocationKey),
            inArray(n.status, ['pending', 'ready', 'waiting']),
          ),
        )
        .catch(rethrowQueryFailure);
      if (updatedNode.rowCount !== 1)
        throw new CoordinatorRunStateCorruptError();
    }
  }
}

async function insertEvents(
  client: PoolClient,
  events: readonly PgInsertValue<typeof runEvents>[],
) {
  // A transition can emit several events per expanded node. Bound statements below PostgreSQL's bind-parameter limit.
  const rowsPerStatement = 1_000;
  for (let offset = 0; offset < events.length; offset += rowsPerStatement) {
    const rows = events.slice(offset, offset + rowsPerStatement);
    const inserted = await drizzle(client)
      .insert(runEvents)
      .values(rows)
      .catch(rethrowQueryFailure);
    if (inserted.rowCount !== rows.length)
      throw new CoordinatorRunStateCorruptError();
  }
}
