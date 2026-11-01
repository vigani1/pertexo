import {
  withTenantScopedReadClient,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../runs/values/stored-execution.js';
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { nodeRuns, nodeAttempts } from '@pertexo/database/schema';
import { readLeasedInputs, readUpstreamOutputs } from './records.queries.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readVariableSetValues } from '../../variables/values.queries.js';
import { workflowNodeFailureValueSchema } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';
import { NodeAttemptStateCorruptError } from '../errors.js';
import type {
  NodeAttemptRunStore,
  NodeAttemptStoredInputs,
} from '../contract.js';
import { attemptControl } from '../queries/control.js';
type UpstreamOutputRow = Awaited<
  ReturnType<typeof readUpstreamOutputs>
>[number];

function reconcileCompletedNodeOutputs(
  expectedOutputs: Parameters<
    NodeAttemptRunStore['loadInputs']
  >[0]['upstreamNodeOutputs'],
  rows: readonly UpstreamOutputRow[],
): readonly Readonly<{
  invocationKey: string;
  nodeId: string;
  value: unknown;
}>[] {
  if (rows.length !== expectedOutputs.length)
    throw new NodeAttemptStateCorruptError();
  const outputsByInvocationKey = new Map(
    rows.map((output) => [output.invocationKey, output]),
  );
  return Object.freeze(
    expectedOutputs.map((expected) => {
      const output = outputsByInvocationKey.get(expected.invocationKey);
      if (output?.nodeId !== expected.nodeId)
        throw new NodeAttemptStateCorruptError();
      const reused = output.reusedSourceRunId !== null;
      if (reused) {
        const invalidReusedOutput =
          output.reusedSourceNodeRunId === null ||
          output.reusedSourceCompletedAt === null ||
          output.currentAttemptId !== null ||
          output.currentAttemptNumber !== null ||
          output.attemptStatus !== null;
        if (invalidReusedOutput) throw new NodeAttemptStateCorruptError();
      } else {
        const invalidAttemptOutput =
          output.attemptStatus !== 'succeeded' ||
          output.reusedSourceNodeRunId !== null ||
          output.reusedSourceCompletedAt !== null ||
          !storedExecutionValuesEqual(
            output.nodeOutputRef,
            output.attemptOutputRef,
          );
        if (invalidAttemptOutput) throw new NodeAttemptStateCorruptError();
      }
      const stored = parseStoredExecutionValue(
        reused ? output.nodeOutputRef : output.attemptOutputRef,
      );
      if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
      return Object.freeze({
        invocationKey: output.invocationKey,
        nodeId: output.nodeId,
        value: stored.value,
      });
    }),
  );
}

export async function loadNodeAttemptInputs(
  pool: Pool,
  input: Parameters<NodeAttemptRunStore['loadInputs']>[0],
): Promise<NodeAttemptStoredInputs> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const current = await readLeasedInputs(client, input);
      const row = current[0];
      if (row === undefined) throw new NodeAttemptStateCorruptError();
      let runInput: unknown = null;
      if (row.inputRef !== null) {
        const stored = parseStoredExecutionValue(row.inputRef);
        if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
        runInput = stored.value;
      }
      let resumeOutput: unknown;
      if (input.lease.admissionKind === 'wait_resume') {
        const resumed = await drizzle(client)
          .select({ outputRef: nodeRuns.outputRef })
          .from(nodeRuns)
          .where(
            and(
              eq(nodeRuns.workspaceId, input.lease.workspaceId),
              eq(nodeRuns.id, input.lease.nodeRunId),
              eq(nodeRuns.currentAttemptId, input.lease.attemptId),
            ),
          )
          .catch(rethrowQueryFailure);
        const stored = parseStoredExecutionValue(resumed[0]?.outputRef);
        if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
        resumeOutput = stored.value;
      }

      let completedNodeOutputs: NodeAttemptStoredInputs['completedNodeOutputs'] =
        Object.freeze([]);
      if (input.upstreamNodeOutputs.length > 0) {
        const outputs = await readUpstreamOutputs(client, input);
        completedNodeOutputs = reconcileCompletedNodeOutputs(
          input.upstreamNodeOutputs,
          outputs,
        );
      }
      const sourceFailure = await readSourceFailure(client, input);
      return Object.freeze({
        ...(sourceFailure === undefined ? {} : { sourceFailure }),
        runInput,
        variables: await readVariableSetValues(
          drizzle(client),
          input.lease.workspaceId,
          row.variableSetRevision,
        ),
        completedNodeOutputs,
        control: attemptControl(row.abortReason),
        ...(row.deadlineAt === null ? {} : { deadlineAt: row.deadlineAt }),
        ...(resumeOutput === undefined ? {} : { resumeOutput }),
        checkpoint: row.schedulerState,
      });
    },
    { signal: input.signal },
  );
}

async function readSourceFailure(
  client: PoolClient,
  input: Parameters<NodeAttemptRunStore['loadInputs']>[0],
): Promise<NodeAttemptStoredInputs['sourceFailure']> {
  let sourceFailure: NodeAttemptStoredInputs['sourceFailure'];
  if (input.sourceFailure !== undefined) {
    const sourceNode = alias(nodeRuns, 'source');
    const handler = alias(nodeRuns, 'handler');
    const source = await drizzle(client)
      .select({
        failureRef: sourceNode.failureRef,
        currentAttemptNumber: sourceNode.currentAttemptNumber,
      })
      .from(sourceNode)
      .innerJoin(
        handler,
        and(
          eq(handler.workspaceId, sourceNode.workspaceId),
          eq(handler.workflowRunId, sourceNode.workflowRunId),
          eq(handler.invocationKey, sourceNode.failureHandlerEntryKey),
        ),
      )
      .innerJoin(
        nodeAttempts,
        and(
          eq(nodeAttempts.workspaceId, handler.workspaceId),
          eq(nodeAttempts.nodeRunId, handler.id),
        ),
      )
      .where(
        and(
          eq(sourceNode.workspaceId, input.lease.workspaceId),
          eq(sourceNode.workflowRunId, input.lease.runId),
          eq(sourceNode.nodeId, input.sourceFailure.nodeId),
          eq(sourceNode.invocationKey, input.sourceFailure.invocationKey),
          eq(sourceNode.status, 'failed'),
          eq(sourceNode.failureHandling, 'pending'),
          eq(handler.id, input.lease.nodeRunId),
          eq(handler.currentAttemptId, input.lease.attemptId),
          eq(handler.currentAttemptNumber, input.lease.attemptNumber),
          eq(nodeAttempts.id, input.lease.attemptId),
          eq(nodeAttempts.attemptNumber, input.lease.attemptNumber),
          eq(nodeAttempts.status, 'running'),
          eq(nodeAttempts.leaseOwner, input.lease.workerId),
          eq(nodeAttempts.fenceToken, input.lease.fenceToken),
          sql`${nodeAttempts.leaseExpiresAt}>clock_timestamp()`,
        ),
      )
      .catch(rethrowQueryFailure);
    const selectedSource = source[0];
    if (source.length !== 1 || selectedSource === undefined)
      throw new NodeAttemptStateCorruptError();
    const stored = parseStoredExecutionValue(selectedSource.failureRef);
    const parsed =
      stored.kind === 'inline'
        ? workflowNodeFailureValueSchema.safeParse(stored.value)
        : undefined;
    const invalidSourceFailure =
      !parsed?.success ||
      parsed.data.attemptNumber !== selectedSource.currentAttemptNumber ||
      parsed.data.nodeId !== input.sourceFailure.nodeId ||
      parsed.data.invocationKey !== input.sourceFailure.invocationKey;
    if (invalidSourceFailure) throw new NodeAttemptStateCorruptError();
    sourceFailure = parsed.data;
  }

  return sourceFailure;
}
