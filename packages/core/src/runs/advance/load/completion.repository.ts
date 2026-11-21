import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import {
  listStoredNodeRunOutcomes,
  readStoredNodeRunOutputs,
} from '../../../shared/run-records/node-run-outputs.repository.js';
import { CoordinatorRunStateCorruptError } from '../coordinator-state.errors.js';
import { withLoopResults } from '../../values/loop-results.js';
import type { JsonValue } from '@pertexo/workflow-model';
import type { InlineAdvanceOptions } from '@pertexo/workflow-engine/server';
import { EXECUTING_RUN_STATUSES } from '../../../shared/run-records/run-statuses.js';
import { decodeStoredValue } from '../../../shared/stored-values.js';
import { and, eq, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  nodeRuns,
  nodeAttempts,
  workflowCalls,
  pendingRunTasks,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { parseStoredExecutionValue } from '../../../shared/stored-execution.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readVariableSetValues } from '../../../variables/values.repository.js';
import type { PoolClient } from 'pg';
import type { RunAdvanceState } from '../run-advance.types.js';

/** This projection is needed only when a callable run is about to succeed. */
export async function readRunCompletionValues(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    inputRef: unknown;
    variableSetRevision: number | null;
    nodeIds: readonly string[] | undefined;
    invocationKeys?: readonly string[];
  }>,
): ReturnType<RunAdvanceState['readCompletionValues']> {
  const storedInput =
    input.inputRef === null
      ? undefined
      : decodeStoredValue(() => parseStoredExecutionValue(input.inputRef));
  const rows =
    input.nodeIds?.length === 0 || input.invocationKeys?.length === 0
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
          : decodeStoredValue(() => parseStoredExecutionValue(row.output_ref));
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
    inArray(n.status, EXECUTING_RUN_STATUSES),
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
        input.invocationKeys === undefined
          ? undefined
          : inArray(n.invocationKey, [...input.invocationKeys]),
        or(eq(n.status, 'succeeded'), completedAttempt, completedControl),
      ),
    )
    .orderBy(n.invocationKey);
}

/** Exact invocation and attempt identities, while the coordinator owns the run lock. */
export async function readInlineValues(
  client: PoolClient,
  run: Omit<
    Parameters<typeof readRunCompletionValues>[1],
    'nodeIds' | 'invocationKeys'
  >,
  request: Parameters<InlineAdvanceOptions['readValues']>[0],
): ReturnType<InlineAdvanceOptions['readValues']> {
  const { workspaceId, runId } = run;
  const completion = await readRunCompletionValues(client, {
    ...run,
    nodeIds: undefined,
    invocationKeys: request.invocationKeys,
  });
  const db = drizzle(client);
  const a = nodeAttempts,
    n = nodeRuns;
  const attempts =
    request.attemptIds.length === 0
      ? []
      : await db
          .select({ attemptId: a.id, output: a.outputRef })
          .from(a)
          .innerJoin(
            n,
            and(eq(a.workspaceId, n.workspaceId), eq(a.nodeRunId, n.id)),
          )
          .where(
            and(
              eq(a.workspaceId, workspaceId),
              eq(n.workflowRunId, runId),
              inArray(a.id, [...request.attemptIds]),
              eq(a.status, 'succeeded'),
            ),
          )
          .catch(rethrowQueryFailure);
  const failures =
    request.failureEntryKey === undefined
      ? []
      : await db
          .select({ failure: n.failureRef })
          .from(n)
          .where(
            and(
              eq(n.workspaceId, workspaceId),
              eq(n.workflowRunId, runId),
              eq(n.failureHandlerEntryKey, request.failureEntryKey),
              eq(n.failureHandling, 'pending'),
            ),
          )
          .limit(1)
          .catch(rethrowQueryFailure);
  const parsed = failures[0]?.failure;
  const source =
    parsed == null
      ? undefined
      : decodeStoredValue(() => parseStoredExecutionValue(parsed));
  const resolved = await Promise.all(
    completion.outputs.flatMap(({ value, ...identity }) =>
      value === undefined
        ? []
        : [resolveLoopOutput(client, run, request, { ...identity, value })],
    ),
  );
  return {
    runInput: completion.runInput ?? null,
    ...(completion.variables === undefined
      ? {}
      : { variables: completion.variables }),
    outputs: resolved.flatMap((output) =>
      output === undefined ? [] : [output],
    ),
    ...(resolved.some((output) => output === undefined)
      ? { loopResultsTooLarge: true }
      : {}),
    attemptOutputs: attempts.flatMap(({ attemptId, output }) => {
      const value =
        output === null
          ? undefined
          : decodeStoredValue(() => parseStoredExecutionValue(output));
      return value?.kind === 'inline'
        ? [{ attemptId, value: value.value }]
        : [];
    }),
    ...(source?.kind === 'inline' ? { sourceFailure: source.value } : {}),
  };
}

async function resolveLoopOutput(
  client: PoolClient,
  scope: Readonly<{ workspaceId: string; runId: string }>,
  request: Parameters<InlineAdvanceOptions['readValues']>[0],
  output: Readonly<{ nodeId: string; invocationKey: string; value: JsonValue }>,
) {
  const loop = request.forEachUpstreams?.find(
    ({ invocationKey }) => invocationKey === output.invocationKey,
  );
  if (loop === undefined) return output;
  const result = await withLoopResults({
    readOutcomes: (nodeId) => listStoredNodeRunOutcomes(client, scope, nodeId),
    readOutputs: async (keys) => {
      const rows = await readStoredNodeRunOutputs(client, scope, keys);
      if (rows === undefined) throw new CoordinatorRunStateCorruptError();
      return rows;
    },
    iterationPath: request.iterationPath,
    output,
    loop,
    maxBytes: NODE_JSON_LIMITS.bytes,
  });
  if (result === undefined) return undefined;
  // The assembler composes only values already decoded by the execution codec.
  return { ...result, value: result.value as JsonValue };
}
