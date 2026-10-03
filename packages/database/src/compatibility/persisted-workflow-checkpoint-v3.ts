import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';
import {
  WORKFLOW_CALL_FAMILY_POLICY_V1,
  workflowCallPinSchemaV1,
} from '@pertexo/workflow-model/workflow-call-contract';
import { z } from 'zod';

import { serializeStoredExecutionJsonValue } from '../execution/stored-execution-value.js';
import {
  parsePersistedWorkflowCheckpoint,
  type PersistedWorkflowCheckpoint,
} from './persisted-workflow-checkpoint.js';

const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const physicalReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), attemptId: uuid }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: uuid }).strict(),
]);
const resultReference = z
  .object({
    kind: z.literal('workflow_call'),
    invocationKey: z.string().min(1).max(256),
    childRunId: uuid,
  })
  .strict();
export const persistedWorkflowOutputReferenceSchemaV3 = z.union([
  physicalReference,
  resultReference,
]);
const declaration = {
  invocationKey: z.string().min(1).max(256),
  nodeId: z.string().min(1).max(128),
  declarationAttemptId: uuid,
  pin: workflowCallPinSchemaV1,
  input: physicalReference,
  inputChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
};
export const persistedWorkflowCallStateSchemaV1 = z.discriminatedUnion(
  'status',
  [
    z
      .object({ ...declaration, status: z.literal('awaiting_admission') })
      .strict(),
    z
      .object({
        ...declaration,
        status: z.literal('admitted'),
        childRunId: uuid,
      })
      .strict(),
    z
      .object({
        ...declaration,
        status: z.literal('refused'),
        reasonCode: z.enum([
          'workflow.child_capacity_unavailable',
          'workflow.child_queue_unavailable',
          'workflow.child_entitlement_unavailable',
          'workflow.child_authority_unavailable',
          'workflow.child_admission_unavailable',
          'workflow.child_compatibility_unavailable',
        ]),
      })
      .strict(),
    z
      .object({
        ...declaration,
        status: z.literal('aborted'),
        reasonCode: z.enum(['workflow.canceled', 'workflow.timed_out']),
      })
      .strict(),
    z
      .object({
        ...declaration,
        status: z.literal('settled'),
        childRunId: uuid,
        childStatus: z.enum([
          'succeeded',
          'failed',
          'canceled',
          'timed_out',
          'outcome_unknown',
        ]),
      })
      .strict(),
  ],
);

export type PersistedWorkflowCallStateV1 = z.output<
  typeof persistedWorkflowCallStateSchemaV1
>;
export type PersistedWorkflowCallResultReferenceV1 = z.output<
  typeof resultReference
>;
type RetainedV2 = Extract<PersistedWorkflowCheckpoint, { schemaVersion: 2 }>;
type OutputReference =
  z.output<typeof physicalReference> | PersistedWorkflowCallResultReferenceV1;
type Invocation = Omit<RetainedV2['invocations'][number], 'output'> & {
  output?: OutputReference | undefined;
};
type Join = Omit<RetainedV2['joins'][number], 'ledger'> & {
  ledger: (Omit<RetainedV2['joins'][number]['ledger'][number], 'output'> & {
    output?: OutputReference | undefined;
  })[];
};
export type PersistedWorkflowCheckpointV3 = Readonly<
  Omit<RetainedV2, 'schemaVersion' | 'invocations' | 'joins'> & {
    schemaVersion: 3;
    invocations: Invocation[];
    joins: Join[];
    calls: PersistedWorkflowCallStateV1[];
  }
>;

class PersistedWorkflowCheckpointInvalidError extends Error {
  public override readonly name = 'PersistedWorkflowCheckpointInvalidError';
  public constructor() {
    super('Persisted workflow checkpoint is invalid');
  }
}

function assertValid(condition: unknown): asserts condition {
  if (!condition) throw new PersistedWorkflowCheckpointInvalidError();
}
function record(value: unknown): Record<string, unknown> {
  assertValid(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function unsettled(call: PersistedWorkflowCallStateV1 | undefined): boolean {
  return call?.status === 'awaiting_admission' || call?.status === 'admitted';
}

function parseCalls(value: unknown): PersistedWorkflowCallStateV1[] {
  const calls = z
    .array(persistedWorkflowCallStateSchemaV1)
    .max(WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns)
    .parse(value);
  const keys = new Set<string>();
  const attempts = new Set<string>();
  const children = new Set<string>();
  for (const call of calls) {
    assertValid(
      !keys.has(call.invocationKey) && !attempts.has(call.declarationAttemptId),
    );
    assertValid(
      call.input.kind !== 'inline' ||
        call.input.attemptId === call.declarationAttemptId,
    );
    keys.add(call.invocationKey);
    attempts.add(call.declarationAttemptId);
    if ('childRunId' in call) {
      assertValid(!children.has(call.childRunId));
      children.add(call.childRunId);
    }
  }
  return calls.sort((a, b) => compare(a.invocationKey, b.invocationKey));
}

function assertCallInvocation(
  call: PersistedWorkflowCallStateV1,
  entry: Invocation | undefined,
  raw: Record<string, unknown> | undefined,
  checkpoint: RetainedV2,
): void {
  assertValid(
    entry !== undefined &&
      raw !== undefined &&
      entry.nodeId === call.nodeId &&
      entry.attemptNumber === 1 &&
      checkpoint.admittedInvocationKeys.includes(call.invocationKey) &&
      !checkpoint.readySet.includes(call.invocationKey),
  );
  assertValid(
    encodeWorkflowInvocationKeyV2({
      workflowVersionId: checkpoint.workflowVersionId,
      nodeId: entry.nodeId,
      branchPath: (entry.branchPath ?? []).map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      ),
      iterationPath: entry.iterationPath ?? [],
    }) === call.invocationKey,
  );
  assertValid(
    !checkpoint.joins.some(({ joinId }) => joinId === call.nodeId) &&
      !checkpoint.loops.some(({ loopId }) => loopId === call.nodeId),
  );
  assertValid(raw.resumeAt === undefined && raw.waitKind === undefined);
  const stopped = (status: string): boolean =>
    (status === 'canceled' && checkpoint.cancelRequested) ||
    (status === 'timed_out' && checkpoint.deadlineExpired);
  if (unsettled(call))
    assertValid(raw.status === 'waiting' && entry.output === undefined);
  else if (call.status === 'aborted')
    assertValid(
      call.reasonCode === 'workflow.canceled'
        ? entry.status === 'canceled' && checkpoint.cancelRequested
        : entry.status === 'timed_out' && checkpoint.deadlineExpired,
    );
  else if (
    call.status === 'settled' &&
    call.childStatus === 'outcome_unknown'
  ) {
    assertValid(
      entry.status === 'outcome_unknown' &&
        ['queued', 'running', 'waiting', 'outcome_unknown'].includes(
          checkpoint.runStatus,
        ),
    );
  } else if (call.status === 'settled' && call.childStatus === 'succeeded') {
    assertValid(entry.status === 'succeeded' || stopped(entry.status));
    if (entry.status === 'succeeded')
      assertValid(
        entry.output?.kind === 'workflow_call' &&
          entry.output.invocationKey === call.invocationKey &&
          entry.output.childRunId === call.childRunId,
      );
  } else assertValid(entry.status === 'failed' || stopped(entry.status));
  assertValid(
    entry.output === undefined ||
      (call.status === 'settled' &&
        call.childStatus === 'succeeded' &&
        entry.status === 'succeeded'),
  );
}

function parseBoundary(value: unknown): PersistedWorkflowCheckpointV3 {
  // Admission owns bytes/depth/members/proxies/accessors before any schema reads.
  const source = record(
    JSON.parse(serializeStoredExecutionJsonValue(value)) as unknown,
  );
  assertValid(source.schemaVersion === 3);
  const calls = parseCalls(source.calls);
  const byKey = new Map(calls.map((call) => [call.invocationKey, call]));
  assertValid(Array.isArray(source.invocations) && Array.isArray(source.joins));
  const rawInvocations = source.invocations.map(record);
  const rawByKey = new Map(
    rawInvocations.map((entry) => [entry.invocationKey, entry]),
  );
  const outputs = new Map<string, PersistedWorkflowCallResultReferenceV1>();
  const ledgers = new Map<
    string,
    Map<string, PersistedWorkflowCallResultReferenceV1>
  >();
  const project = (
    output: unknown,
  ): { output: unknown; result?: PersistedWorkflowCallResultReferenceV1 } => {
    if (
      output === null ||
      typeof output !== 'object' ||
      Array.isArray(output) ||
      record(output).kind !== 'workflow_call'
    )
      return { output };
    const result = resultReference.parse(output);
    const call = byKey.get(result.invocationKey);
    const origin = rawByKey.get(result.invocationKey);
    assertValid(
      call?.status === 'settled' &&
        call.childStatus === 'succeeded' &&
        call.childRunId === result.childRunId &&
        origin?.nodeId === call.nodeId &&
        origin.status === 'succeeded',
    );
    return {
      output: { kind: 'inline', attemptId: call.declarationAttemptId },
      result,
    };
  };
  const invocations = rawInvocations.map((entry) => {
    const { output, result } = project(entry.output);
    if (result !== undefined) {
      assertValid(typeof entry.invocationKey === 'string');
      outputs.set(entry.invocationKey, result);
    }
    const call =
      typeof entry.invocationKey === 'string'
        ? byKey.get(entry.invocationKey)
        : undefined;
    return {
      ...entry,
      ...(entry.output === undefined ? {} : { output }),
      status:
        unsettled(call) && entry.status === 'waiting'
          ? 'running'
          : entry.status,
    };
  });
  const joins = source.joins.map((value) => {
    const join = record(value);
    assertValid(Array.isArray(join.ledger));
    const identity = join.joinInvocationKey ?? join.joinId;
    assertValid(typeof identity === 'string');
    const originals = new Map<string, PersistedWorkflowCallResultReferenceV1>();
    const ledger = join.ledger.map((value) => {
      const branch = record(value);
      const { output, result } = project(branch.output);
      if (result !== undefined) {
        assertValid(typeof branch.branchId === 'string');
        originals.set(branch.branchId, result);
      }
      return { ...branch, ...(branch.output === undefined ? {} : { output }) };
    });
    ledgers.set(identity, originals);
    return { ...join, ledger };
  });
  const { calls: _calls, ...ordinary } = source;
  // Never expose this V2 projection to persistence or execution owners.
  const parsed = parsePersistedWorkflowCheckpoint({
    ...ordinary,
    schemaVersion: 2,
    invocations,
    joins,
  });
  assertValid(parsed.schemaVersion === 2);
  const restored = parsed.invocations
    .map((entry): Invocation => ({
      ...entry,
      ...(unsettled(byKey.get(entry.invocationKey))
        ? { status: 'waiting' as const }
        : {}),
      ...(outputs.has(entry.invocationKey)
        ? { output: outputs.get(entry.invocationKey) }
        : {}),
    }))
    .sort((a, b) => compare(a.invocationKey, b.invocationKey));
  const invocationByKey = new Map(
    restored.map((entry) => [entry.invocationKey, entry]),
  );
  for (const call of calls)
    assertCallInvocation(
      call,
      invocationByKey.get(call.invocationKey),
      rawByKey.get(call.invocationKey),
      parsed,
    );
  if (!['queued', 'running', 'waiting'].includes(parsed.runStatus))
    assertValid(!calls.some(unsettled));
  return Object.freeze({
    ...parsed,
    schemaVersion: 3,
    calls,
    invocations: restored,
    joins: parsed.joins.map((join): Join => ({
      ...join,
      ledger: join.ledger.map((branch) => {
        const output = ledgers
          .get(join.joinInvocationKey ?? join.joinId)
          ?.get(branch.branchId);
        return { ...branch, ...(output === undefined ? {} : { output }) };
      }),
    })),
  });
}

/** Wire self-consistency only; physical ownership and journal transitions remain DB-owner checks. */
export function parsePersistedWorkflowCheckpointV3(
  value: unknown,
): PersistedWorkflowCheckpointV3 {
  try {
    return parseBoundary(value);
  } catch {
    throw new PersistedWorkflowCheckpointInvalidError();
  }
}

export function parseInitialWorkflowCheckpointV3(
  value: unknown,
  identity: Readonly<{ engineVersion: string; workflowVersionId: string }>,
): PersistedWorkflowCheckpointV3 {
  const checkpoint = parsePersistedWorkflowCheckpointV3(value);
  assertValid(
    checkpoint.engineVersion === identity.engineVersion &&
      checkpoint.workflowVersionId === identity.workflowVersionId &&
      checkpoint.revision === 0 &&
      checkpoint.runStatus === 'queued' &&
      checkpoint.nextEventSequence === 2 &&
      checkpoint.readySet.length === 0 &&
      checkpoint.admittedInvocationKeys.length === 0 &&
      checkpoint.invocations.length === 0 &&
      checkpoint.joins.length === 0 &&
      checkpoint.loops.length === 0 &&
      checkpoint.calls.length === 0 &&
      !checkpoint.cancelRequested &&
      !checkpoint.deadlineExpired,
  );
  return checkpoint;
}

export function serializePersistedWorkflowCheckpointV3(value: unknown): string {
  return serializeStoredExecutionJsonValue(
    parsePersistedWorkflowCheckpointV3(value),
  );
}
