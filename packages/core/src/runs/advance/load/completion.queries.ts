import { and, eq, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  nodeRuns,
  nodeAttempts,
  workflowCalls,
  pendingRunTasks,
} from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  parseStoredExecutionValue,
} from '@pertexo/database/primitives';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readVariableSetValues } from '../../../variables/values.queries.js';
import type { PoolClient } from 'pg';
import type { RunAdvanceState } from '../contract.js';

/** This projection is needed only when a callable run is about to succeed. */
export async function readRunCompletionValues(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    inputRef: unknown;
    variableSetRevision: number | null;
    nodeIds: readonly string[] | undefined;
  }>,
): ReturnType<RunAdvanceState['readCompletionValues']> {
  const storedInput =
    input.inputRef === null
      ? undefined
      : parseStoredExecutionValue(input.inputRef);
  const rows =
    input.nodeIds?.length === 0
      ? []
      : await completionRows(client, input).catch(rethrowQueryFailure);
  return {
    variables: await readVariableSetValues(
      drizzle(client),
      input.workspaceId,
      input.variableSetRevision,
    ),
    runInput: storedInput?.kind === 'inline' ? storedInput.value : undefined,
    outputs: rows.map((row) => {
      const stored =
        row.output_ref === null
          ? undefined
          : parseStoredExecutionValue(row.output_ref);
      return {
        nodeId: row.node_id,
        invocationKey: row.invocation_key,
        value: stored?.kind === 'inline' ? stored.value : undefined,
      };
    }),
  };
}

function completionRows(
  client: PoolClient,
  input: Parameters<typeof readRunCompletionValues>[1],
) {
  const n = nodeRuns,
    a = nodeAttempts,
    c = alias(workflowCalls, 'call'),
    t = alias(pendingRunTasks, 'task');
  const reused = and(
    isNotNull(n.reusedSourceRunId),
    isNotNull(n.reusedSourceNodeRunId),
    isNotNull(n.reusedSourceCompletedAt),
    isNull(n.currentAttemptId),
    isNull(n.currentAttemptNumber),
    eq(n.status, 'succeeded'),
  );
  const completedAttempt = and(
    inArray(n.status, ['running', 'waiting']),
    eq(a.status, 'succeeded'),
    isNull(n.controlKind),
  );
  const completedControl = and(
    eq(n.status, 'waiting'),
    or(isNotNull(t.id), isNotNull(c.id)),
  );
  return drizzle(client)
    .select({
      node_id: n.nodeId,
      invocation_key: n.invocationKey,
      output_ref: sql<unknown>`case when ${reused} then ${n.outputRef} when ${t.id} is not null then ${t.outputRef} when ${c.id} is not null then ${c.resultRef} else coalesce(${a.outputRef},${n.outputRef}) end`,
    })
    .from(n)
    .leftJoin(
      a,
      and(
        eq(a.workspaceId, n.workspaceId),
        eq(a.nodeRunId, n.id),
        eq(a.id, n.currentAttemptId),
        eq(a.attemptNumber, n.currentAttemptNumber),
      ),
    )
    .leftJoin(
      c,
      and(
        eq(c.workspaceId, n.workspaceId),
        eq(c.parentRunId, n.workflowRunId),
        eq(c.invocationKey, n.invocationKey),
        eq(c.status, 'succeeded'),
      ),
    )
    .leftJoin(
      t,
      and(
        eq(t.workspaceId, n.workspaceId),
        eq(t.runId, n.workflowRunId),
        eq(t.nodeRunId, n.id),
        eq(t.invocationKey, n.invocationKey),
        isNotNull(t.outputRef),
      ),
    )
    .where(
      and(
        eq(n.workspaceId, input.workspaceId),
        eq(n.workflowRunId, input.runId),
        input.nodeIds === undefined
          ? undefined
          : inArray(n.nodeId, [...input.nodeIds]),
        or(eq(n.status, 'succeeded'), completedAttempt, completedControl),
      ),
    )
    .orderBy(n.invocationKey);
}
