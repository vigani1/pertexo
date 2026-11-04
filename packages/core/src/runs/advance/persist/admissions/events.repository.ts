import { TERMINAL_NODE_FIELDS } from '../settlement.repository.js';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { nodeRuns, runEvents } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { serializeStoredExecutionJsonValue } from '../../../../shared/stored-execution.js';
import type { PoolClient } from 'pg';
import { CoordinatorRunStateCorruptError } from '../../../state-errors.js';
import type { PendingCoordinatorFailure } from '../../load/coordinator-state.repository.js';
import { terminalStatus } from '../../load/event-facts.repository.js';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';

import type { ExecutionIdentityMap } from './execution-identity.types.js';

export async function loadEventExecutionIdentities(
  client: PoolClient,
  physical: ExecutionIdentityMap,
  {
    plan,
    workspaceId,
    runId,
  }: Readonly<{
    plan: WorkflowTransitionPlan;
    workspaceId: string;
    runId: string;
  }>,
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
    plan: WorkflowTransitionPlan;
    runId: string;
    workspaceId: string;
    rejectedForEachDeclarations: ReadonlySet<string>;
  }>,
): Promise<void> {
  const { physical, plan, runId, workspaceId } = input;
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
  await settleInvocations(client, input);
}

/**
 * One statement for every step these events settle: a run cancelled across thousands
 * of steps would otherwise hold its lock through a round trip for each.
 */
async function settleInvocations(
  client: PoolClient,
  input: Parameters<typeof persistRunEvents>[1],
): Promise<void> {
  const { pendingFailures, plan, runId, workspaceId } = input;
  const pendingFailureInvocations = new Set(
    pendingFailures.map(({ invocation_key: invocationKey }) => invocationKey),
  );
  const settled = plan.events.flatMap((event) => {
    const status = terminalStatus(event.name);
    return status === undefined ||
      event.invocationKey === undefined ||
      pendingFailureInvocations.has(event.invocationKey) ||
      input.rejectedForEachDeclarations.has(event.invocationKey)
      ? []
      : [
          {
            key: event.invocationKey,
            status,
            // A succeeded step's reason (callback received, timed out) is
            // event copy, never an error code.
            code: status === 'succeeded' ? null : (event.reasonCode ?? null),
          },
        ];
  });
  if (settled.length === 0) return;
  const n = nodeRuns;
  const updated = await drizzle(client)
    .update(n)
    .set({
      status: sql`settled.status`,
      ...TERMINAL_NODE_FIELDS,
      safeErrorCode: sql`settled.code`,
    })
    .from(
      sql`unnest(${sql.param(settled.map(({ key }) => key))}::text[],${sql.param(settled.map(({ status }) => status))}::text[],${sql.param(settled.map(({ code }) => code))}::text[]) settled(key,status,code)`,
    )
    .where(
      and(
        eq(n.workspaceId, workspaceId),
        eq(n.workflowRunId, runId),
        sql`${n.invocationKey}=settled.key`,
        inArray(n.status, ['pending', 'ready', 'waiting']),
      ),
    )
    .catch(rethrowQueryFailure);
  if (updated.rowCount !== settled.length)
    throw new CoordinatorRunStateCorruptError();
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
