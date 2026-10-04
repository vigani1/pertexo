import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  NodeAttemptStateCorruptError,
  type loadInputsSchema,
  type NodeAttemptInputs,
} from './node-attempt-run-store-contract.js';
import { assertNotAborted } from './node-attempt-run-store-transactions.js';
import { workflowCallAttemptAuthorityJson } from './node-attempt-call-input-record.js';
import { parseNativeNodeAttemptValueSources } from './native-node-attempt-value-sources.js';

type NativeInputControl = Readonly<{
  abort_requested: boolean;
  abort_reason: 'canceled' | 'timed_out' | null;
  deadline_at: Date | null;
  input_ref: unknown;
  executable_checksum: string;
}>;

/** Select original-byte sources with the current attempt consumer, never decoded retained values. */
export async function loadNativeNodeAttemptInputs(
  client: PoolClient,
  input: z.output<typeof loadInputsSchema>,
  row: NativeInputControl,
  coordinatorInput: NodeAttemptInputs['coordinatorInput'],
): Promise<NodeAttemptInputs> {
  // Native bytes come only from the current attempt consumer's protected
  // selected-source owner, never the driver's decoded retained columns.
  // Aborted work performs no source SQL after the actual control read.
  const base = {
    runInput: null,
    completedNodeOutputs: Object.freeze([]),
    abortRequested: row.abort_requested,
    ...(row.abort_reason === null ? {} : { abortReason: row.abort_reason }),
    ...(row.deadline_at === null
      ? {}
      : { deadlineAt: z.coerce.date().parse(row.deadline_at) }),
  };
  if (row.abort_requested) return Object.freeze(base);
  if (
    input.lease.admissionKind === 'wait_resume' ||
    (input.lease.iterationPath?.length ?? 0) > 0
  )
    throw new Error('Native Wait/structured source loading is not implemented');
  const selections = [
    { slot: 'run_input' },
    ...input.upstreamNodeOutputs.map(({ nodeId, invocationKey }) => ({
      slot: 'upstream_output',
      nodeId,
      invocationKey,
    })),
  ];
  const sources: unknown[] = [];
  for (const selection of selections) {
    assertNotAborted(input.signal);
    const selected = await client.query<{ source: unknown }>(
      'select app.read_native_attempt_value_source($1::jsonb,$2::jsonb) as source',
      [
        workflowCallAttemptAuthorityJson(input.lease),
        JSON.stringify(selection),
      ],
    );
    assertNotAborted(input.signal);
    if (selected.rows.length !== 1) throw new NodeAttemptStateCorruptError();
    if (selected.rows[0]?.source !== null)
      sources.push(selected.rows[0]?.source);
  }
  const nativeValueSources = parseNativeNodeAttemptValueSources(
    {
      workspaceId: input.lease.workspaceId,
      runId: input.lease.runId,
      workflowVersionId: input.lease.workflowVersionId,
      nodeId: input.lease.nodeId,
      invocationKey: input.lease.invocationKey,
      admissionKind: input.lease.admissionKind,
      graphSchemaVersion: 2,
      executableSchemaVersion: 3,
      executableChecksum: row.executable_checksum,
      checkpointSchemaVersion: 3,
      runInputPresent: row.input_ref !== null,
      upstreamNodeOutputs: input.upstreamNodeOutputs,
    },
    sources,
  );
  return Object.freeze({
    ...base,
    nativeValueSources,
    ...(coordinatorInput === undefined ? {} : { coordinatorInput }),
  });
}
