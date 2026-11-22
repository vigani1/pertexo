import { decodeStoredValue } from '../../shared/stored-values.js';
import { withTenantScopedReadClient } from '@pertexo/database/primitives';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../shared/stored-execution.js';
import {
  readLeasedInputs,
  readResumeOutput,
  readSourceFailureRows,
  readUpstreamOutputs,
} from './leased-inputs.repository.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readVariableSetValues } from '../../variables/values.repository.js';
import { workflowNodeFailureValueSchema } from '@pertexo/workflow-model';
import { parseCheckpoint } from '@pertexo/workflow-engine/server';
import type { Pool, PoolClient } from 'pg';
import {
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
} from '../node-attempt.errors.js';
import type {
  NodeAttemptStoredInputs,
  LoadInputsInput,
} from '../node-attempt.js';
import { attemptControl } from '../control.js';
type UpstreamOutputRow = Awaited<
  ReturnType<typeof readUpstreamOutputs>
>[number];

function reconcileCompletedNodeOutputs(
  expectedOutputs: LoadInputsInput['upstreamNodeOutputs'],
  rows: readonly UpstreamOutputRow[],
  checkpoint: unknown,
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
  const agentOutputs = rows.some(
    ({ currentAttemptId, reusedSourceRunId }) =>
      currentAttemptId === null && reusedSourceRunId === null,
  )
    ? new Set(
        decodeStoredValue(() => parseCheckpoint(checkpoint))
          .agents?.filter(({ phase }) => phase.kind === 'completion')
          .map(({ parentInvocationKey }) => parentInvocationKey),
      )
    : undefined;
  return Object.freeze(
    expectedOutputs.map((expected) => {
      const output = outputsByInvocationKey.get(expected.invocationKey);
      if (output?.nodeId !== expected.nodeId)
        throw new NodeAttemptStateCorruptError();
      const reused = output.reusedSourceRunId !== null;
      const agent = agentOutputs?.has(expected.invocationKey) === true;
      if (reused) {
        const invalidReusedOutput =
          output.reusedSourceNodeRunId === null ||
          output.reusedSourceCompletedAt === null ||
          output.currentAttemptId !== null ||
          output.currentAttemptNumber !== null ||
          output.attemptStatus !== null;
        if (invalidReusedOutput) throw new NodeAttemptStateCorruptError();
      } else if (!agent) {
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
      const stored = decodeStoredValue(() =>
        parseStoredExecutionValue(
          reused || agent ? output.nodeOutputRef : output.attemptOutputRef,
        ),
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
  input: LoadInputsInput,
): Promise<NodeAttemptStoredInputs> {
  return withTenantScopedReadClient(
    pool,
    { workspaceId: input.lease.workspaceId },
    async (client) => {
      const current = await readLeasedInputs(client, input);
      const row = current[0];
      if (row === undefined) throw new NodeAttemptReconciliationRequiredError();
      let runInput: unknown = null;
      if (row.inputRef !== null) {
        const stored = decodeStoredValue(() =>
          parseStoredExecutionValue(row.inputRef),
        );
        if (stored.kind !== 'inline') throw new NodeAttemptStateCorruptError();
        runInput = stored.value;
      }
      let resumeOutput: unknown;
      if (input.lease.admissionKind === 'wait_resume') {
        const resumed = await readResumeOutput(client, input.lease);
        const stored = decodeStoredValue(() =>
          parseStoredExecutionValue(resumed?.outputRef),
        );
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
          row.schedulerState,
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
  input: LoadInputsInput,
): Promise<NodeAttemptStoredInputs['sourceFailure']> {
  let sourceFailure: NodeAttemptStoredInputs['sourceFailure'];
  if (input.sourceFailure !== undefined) {
    const source = await readSourceFailureRows(client, {
      lease: input.lease,
      sourceFailure: input.sourceFailure,
    });
    const selectedSource = source[0];
    if (source.length !== 1 || selectedSource === undefined)
      throw new NodeAttemptStateCorruptError();
    const stored = decodeStoredValue(() =>
      parseStoredExecutionValue(selectedSource.failureRef),
    );
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
