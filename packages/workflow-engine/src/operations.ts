import {
  NodeExecutionAbortedError,
  type JsonValue as NodeJsonValue,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model/graph';
import {
  resolveValueSource,
  type ValueResolution,
} from '@pertexo/workflow-model/mapping';

import {
  advanceWorkflowFromSchedulerState,
  type WorkflowObservation,
} from './advance-workflow.js';
import { WorkflowEngineError } from './errors.js';
import {
  assertAuthenticExecutableIdentity,
  normalizeBoundedEngineJson,
  type CompiledWorkflowExecutableV2,
  type WorkflowExecutableNodeV2,
} from './executable-workflow.js';
import { parseCheckpoint } from './checkpoint.js';
import type { SchedulerState } from './graph-scheduler.js';
import { compareOrdinal } from './ordering.js';
import { providerIdempotencyKey } from './retries.js';
import { invocationKey as createInvocationKey } from './scheduling.js';
import type { OutputReference, WorkflowTransitionPlan } from './types.js';

function operationError(
  code:
    | 'observation_invalid'
    | 'attempt_invalid'
    | 'attempt_aborted'
    | 'workflow_identity_invalid',
  message: string,
): never {
  throw new WorkflowEngineError(code, message);
}

function record(
  value: JsonValue,
  code: 'observation_invalid' | 'attempt_invalid',
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (!isJsonRecord(value)) operationError(code, `${label} must be an object`);
  return value;
}

function isJsonRecord(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  )
    operationError('observation_invalid', 'observation fields are invalid');
}

type OutcomeObservation = Extract<
  WorkflowObservation,
  { readonly kind: 'outcome' }
>;
type PersistedOutcomeStatus = Exclude<OutcomeObservation['status'], 'skipped'>;

export type PersistedWorkflowObservation = Readonly<
  { readonly sequence: number; readonly occurredAt: string } & (
    | Readonly<{
        readonly kind: 'outcome';
        readonly invocationKey: string;
        readonly status: PersistedOutcomeStatus;
        readonly output?: OutputReference;
        readonly reasonCode?: string;
        readonly attemptId: string;
        readonly attemptNumber: number;
      }>
    | { readonly kind: 'cancel_requested' }
    | {
        readonly kind: 'cursor_only';
        readonly eventName: 'node.started' | 'node.progress';
        readonly invocationKey: string;
        readonly attemptId: string;
        readonly attemptNumber: number;
      }
    | {
        readonly kind: 'wait';
        readonly eventName: 'node.waiting' | 'node.retry_scheduled';
        readonly invocationKey: string;
        readonly attemptId: string;
        readonly attemptNumber: number;
        readonly resumeAt: string;
      }
  )
>;

export type DeadlineExpiredObservation = Readonly<{
  readonly kind: 'deadline_expired';
  readonly occurredAt: string;
}>;

export type DueAtObservation = Readonly<{
  readonly kind: 'due_at';
  readonly occurredAt: string;
  readonly invocationKey: string;
}>;

type ParsedPersistedObservations = Readonly<{
  observations: readonly WorkflowObservation[];
  deadlineExpiration?: DeadlineExpiredObservation;
  dueResumptions: readonly DueAtObservation[];
  cursor: Readonly<{
    expectedNextEventSequence: number;
    consumedThroughEventSequence: number;
  }>;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isPersistedOutcomeStatus(
  value: unknown,
): value is PersistedOutcomeStatus {
  return (
    typeof value === 'string' &&
    ['succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown'].some(
      (candidate) => candidate === value,
    )
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 35) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function samePersistedFact(
  left: PersistedWorkflowObservation,
  right: PersistedWorkflowObservation,
): boolean {
  if (
    left.sequence !== right.sequence ||
    left.occurredAt !== right.occurredAt ||
    left.kind !== right.kind
  )
    return false;
  if (left.kind === 'cancel_requested')
    return right.kind === 'cancel_requested';
  if (left.kind === 'cursor_only')
    return (
      right.kind === 'cursor_only' &&
      left.eventName === right.eventName &&
      left.invocationKey === right.invocationKey &&
      left.attemptId === right.attemptId &&
      left.attemptNumber === right.attemptNumber
    );
  if (left.kind === 'wait')
    return (
      right.kind === 'wait' &&
      left.eventName === right.eventName &&
      left.invocationKey === right.invocationKey &&
      left.attemptId === right.attemptId &&
      left.attemptNumber === right.attemptNumber &&
      left.resumeAt === right.resumeAt
    );
  if (right.kind !== 'outcome') return false;
  return (
    left.attemptId === right.attemptId &&
    left.attemptNumber === right.attemptNumber &&
    left.invocationKey === right.invocationKey &&
    left.status === right.status &&
    left.reasonCode === right.reasonCode &&
    left.output?.kind === right.output?.kind &&
    (left.output?.kind === 'inline' && right.output?.kind === 'inline'
      ? left.output.attemptId === right.output.attemptId
      : left.output?.kind === 'artifact' && right.output?.kind === 'artifact'
        ? left.output.artifactId === right.output.artifactId
        : left.output === undefined && right.output === undefined)
  );
}

function staleFactMatchesCheckpoint(
  observation: PersistedWorkflowObservation,
  checkpoint: ReturnType<typeof parseCheckpoint>,
): boolean {
  if (observation.kind === 'cancel_requested')
    return checkpoint.cancelRequested;
  if (observation.kind === 'cursor_only') {
    return checkpoint.invocations.some(
      ({ invocationKey, attemptNumber }) =>
        invocationKey === observation.invocationKey &&
        attemptNumber === observation.attemptNumber,
    );
  }
  if (observation.kind === 'wait') {
    const invocation = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === observation.invocationKey,
    );
    return (
      invocation?.status === 'waiting' &&
      invocation.attemptNumber === observation.attemptNumber &&
      invocation.resumeAt === observation.resumeAt
    );
  }
  const invocation = checkpoint.invocations.find(
    ({ invocationKey }) => invocationKey === observation.invocationKey,
  );
  return (
    invocation?.attemptNumber === observation.attemptNumber &&
    invocation.status === observation.status &&
    invocation.output?.kind === observation.output?.kind &&
    (invocation.output?.kind === 'inline' &&
    observation.output?.kind === 'inline'
      ? invocation.output.attemptId === observation.output.attemptId
      : invocation.output?.kind === 'artifact' &&
          observation.output?.kind === 'artifact'
        ? invocation.output.artifactId === observation.output.artifactId
        : invocation.output === undefined && observation.output === undefined)
  );
}

function parseObservations(
  value: unknown,
  checkpoint: ReturnType<typeof parseCheckpoint>,
): ParsedPersistedObservations {
  let normalized: JsonValue;
  try {
    normalized = normalizeBoundedEngineJson(value ?? []);
  } catch (error) {
    operationError(
      'observation_invalid',
      error instanceof Error ? error.message : 'observations are invalid',
    );
  }
  if (!Array.isArray(normalized))
    operationError('observation_invalid', 'observations must be an array');
  const items = normalized as readonly JsonValue[];
  const parsed: (
    PersistedWorkflowObservation | DeadlineExpiredObservation | DueAtObservation
  )[] = items.map(
    (
      item,
    ):
      | PersistedWorkflowObservation
      | DeadlineExpiredObservation
      | DueAtObservation => {
      const observation = record(item, 'observation_invalid', 'observation');
      if (observation.kind === 'deadline_expired') {
        exactKeys(observation, ['kind', 'occurredAt']);
        if (!isCanonicalTimestamp(observation.occurredAt))
          operationError(
            'observation_invalid',
            'deadline timestamp is invalid',
          );
        return {
          kind: 'deadline_expired',
          occurredAt: observation.occurredAt,
        };
      }
      if (observation.kind === 'due_at') {
        exactKeys(observation, ['kind', 'occurredAt', 'invocationKey']);
        if (
          !isCanonicalTimestamp(observation.occurredAt) ||
          typeof observation.invocationKey !== 'string' ||
          observation.invocationKey.length === 0 ||
          observation.invocationKey.length > 256
        )
          operationError('observation_invalid', 'due observation is invalid');
        return {
          kind: observation.kind,
          occurredAt: observation.occurredAt,
          invocationKey: observation.invocationKey,
        };
      }
      if (
        !Number.isSafeInteger(observation.sequence) ||
        typeof observation.sequence !== 'number' ||
        observation.sequence <= 0 ||
        !isCanonicalTimestamp(observation.occurredAt)
      )
        operationError('observation_invalid', 'observation cursor is invalid');
      if (observation.kind === 'cancel_requested') {
        exactKeys(observation, ['kind', 'sequence', 'occurredAt']);
        return {
          kind: 'cancel_requested',
          sequence: observation.sequence,
          occurredAt: observation.occurredAt,
        };
      }
      if (observation.kind === 'cursor_only') {
        exactKeys(observation, [
          'kind',
          'eventName',
          'sequence',
          'occurredAt',
          'invocationKey',
          'attemptId',
          'attemptNumber',
        ]);
        if (
          observation.eventName !== 'node.started' &&
          observation.eventName !== 'node.progress'
        )
          operationError('observation_invalid', 'cursor event name is invalid');
        if (
          typeof observation.invocationKey !== 'string' ||
          observation.invocationKey.length === 0 ||
          observation.invocationKey.length > 256 ||
          typeof observation.attemptId !== 'string' ||
          !uuidPattern.test(observation.attemptId) ||
          typeof observation.attemptNumber !== 'number' ||
          !Number.isSafeInteger(observation.attemptNumber) ||
          observation.attemptNumber <= 0
        )
          operationError('observation_invalid', 'cursor event is invalid');
        return {
          kind: observation.kind,
          eventName: observation.eventName,
          sequence: observation.sequence,
          occurredAt: observation.occurredAt,
          invocationKey: observation.invocationKey,
          attemptId: observation.attemptId,
          attemptNumber: observation.attemptNumber,
        };
      }
      if (observation.kind === 'wait') {
        exactKeys(observation, [
          'kind',
          'eventName',
          'sequence',
          'occurredAt',
          'invocationKey',
          'attemptId',
          'attemptNumber',
          'resumeAt',
        ]);
        if (
          (observation.eventName !== 'node.waiting' &&
            observation.eventName !== 'node.retry_scheduled') ||
          typeof observation.invocationKey !== 'string' ||
          observation.invocationKey.length === 0 ||
          observation.invocationKey.length > 256 ||
          typeof observation.attemptId !== 'string' ||
          !uuidPattern.test(observation.attemptId) ||
          typeof observation.attemptNumber !== 'number' ||
          !Number.isSafeInteger(observation.attemptNumber) ||
          observation.attemptNumber <= 0 ||
          !isCanonicalTimestamp(observation.resumeAt)
        )
          operationError('observation_invalid', 'wait observation is invalid');
        return {
          kind: observation.kind,
          eventName: observation.eventName,
          sequence: observation.sequence,
          occurredAt: observation.occurredAt,
          invocationKey: observation.invocationKey,
          attemptId: observation.attemptId,
          attemptNumber: observation.attemptNumber,
          resumeAt: observation.resumeAt,
        };
      }
      if (observation.kind !== 'outcome')
        operationError(
          'observation_invalid',
          'observation kind is unsupported in Phase 3',
        );
      exactKeys(
        observation,
        [
          'kind',
          'sequence',
          'occurredAt',
          'attemptId',
          'attemptNumber',
          'invocationKey',
          'status',
        ],
        ['output', 'reasonCode'],
      );
      if (
        typeof observation.invocationKey !== 'string' ||
        typeof observation.attemptId !== 'string' ||
        !uuidPattern.test(observation.attemptId) ||
        typeof observation.attemptNumber !== 'number' ||
        !Number.isSafeInteger(observation.attemptNumber) ||
        observation.attemptNumber <= 0 ||
        !isPersistedOutcomeStatus(observation.status)
      )
        operationError('observation_invalid', 'outcome observation is invalid');
      let output: Extract<
        WorkflowObservation,
        { readonly kind: 'outcome' }
      >['output'];
      if (observation.output !== undefined) {
        const candidate = record(
          observation.output,
          'observation_invalid',
          'output reference',
        );
        if (candidate.kind === 'inline') {
          exactKeys(candidate, ['kind', 'attemptId']);
          if (
            typeof candidate.attemptId !== 'string' ||
            !uuidPattern.test(candidate.attemptId) ||
            candidate.attemptId !== observation.attemptId
          )
            operationError(
              'observation_invalid',
              'inline output must reference the completing attempt',
            );
          output = { kind: candidate.kind, attemptId: candidate.attemptId };
        } else if (candidate.kind === 'artifact') {
          exactKeys(candidate, ['kind', 'artifactId']);
          if (
            typeof candidate.artifactId !== 'string' ||
            !uuidPattern.test(candidate.artifactId)
          )
            operationError('observation_invalid', 'artifact output is invalid');
          output = { kind: candidate.kind, artifactId: candidate.artifactId };
        } else
          operationError(
            'observation_invalid',
            'output reference kind is invalid',
          );
      }
      if (
        observation.reasonCode !== undefined &&
        (typeof observation.reasonCode !== 'string' ||
          observation.reasonCode.length === 0 ||
          observation.reasonCode.length > 128)
      )
        operationError('observation_invalid', 'reasonCode is invalid');
      return {
        kind: 'outcome',
        sequence: observation.sequence,
        occurredAt: observation.occurredAt,
        attemptId: observation.attemptId,
        attemptNumber: observation.attemptNumber,
        invocationKey: observation.invocationKey,
        status: observation.status,
        ...(output === undefined ? {} : { output }),
        ...(observation.reasonCode === undefined
          ? {}
          : { reasonCode: observation.reasonCode }),
      };
    },
  );
  let deadlineExpiration: DeadlineExpiredObservation | undefined;
  const dueResumptions: DueAtObservation[] = [];
  const sequenced: PersistedWorkflowObservation[] = [];
  for (const observation of parsed) {
    if (observation.kind === 'due_at') {
      const previous = dueResumptions.find(
        ({ invocationKey }) => invocationKey === observation.invocationKey,
      );
      if (
        previous !== undefined &&
        previous.occurredAt !== observation.occurredAt
      )
        operationError('observation_invalid', 'due observation conflicts');
      if (previous === undefined) dueResumptions.push(observation);
      continue;
    }
    if (observation.kind !== 'deadline_expired') {
      sequenced.push(observation);
      continue;
    }
    if (
      deadlineExpiration !== undefined &&
      deadlineExpiration.occurredAt !== observation.occurredAt
    )
      operationError('observation_invalid', 'deadline observation conflicts');
    deadlineExpiration = observation;
  }
  dueResumptions.sort(
    (left, right) =>
      compareOrdinal(left.invocationKey, right.invocationKey) ||
      compareOrdinal(left.occurredAt, right.occurredAt),
  );
  for (const due of dueResumptions) {
    const invocation = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === due.invocationKey,
    );
    if (invocation === undefined)
      operationError('observation_invalid', 'due invocation is unknown');
    if (invocation.status === 'waiting') {
      if (
        invocation.resumeAt === undefined ||
        due.occurredAt < invocation.resumeAt
      )
        operationError('observation_invalid', 'due observation is early');
      continue;
    }
    if (invocation.status !== 'ready' && invocation.status !== 'running')
      operationError('observation_invalid', 'due invocation is not resumable');
  }
  const unique: PersistedWorkflowObservation[] = [];
  for (const observation of sequenced) {
    const previous = unique.at(-1);
    if (previous !== undefined && observation.sequence < previous.sequence)
      operationError('observation_invalid', 'observations are out of order');
    if (previous?.sequence === observation.sequence) {
      if (!samePersistedFact(previous, observation))
        operationError('observation_invalid', 'observation sequence conflicts');
      continue;
    }
    unique.push(observation);
  }
  const fresh: PersistedWorkflowObservation[] = [];
  for (const observation of unique) {
    if (observation.sequence < checkpoint.nextEventSequence) {
      if (!staleFactMatchesCheckpoint(observation, checkpoint))
        operationError('observation_invalid', 'stale observation conflicts');
      continue;
    }
    const expected = checkpoint.nextEventSequence + fresh.length;
    if (observation.sequence !== expected)
      operationError('observation_invalid', 'observation sequence has a gap');
    fresh.push(observation);
  }
  for (const observation of fresh) {
    if (
      observation.kind !== 'outcome' &&
      observation.kind !== 'wait' &&
      observation.kind !== 'cursor_only'
    )
      continue;
    const invocation = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === observation.invocationKey,
    );
    if (invocation?.attemptNumber !== observation.attemptNumber)
      operationError('observation_invalid', 'observation attempt is stale');
  }
  return {
    observations: fresh.map((observation): WorkflowObservation => {
      if (observation.kind === 'cancel_requested')
        return { kind: observation.kind };
      if (observation.kind === 'cursor_only') return { kind: observation.kind };
      if (observation.kind === 'wait') {
        return {
          kind: observation.kind,
          invocationKey: observation.invocationKey,
          resumeAt: observation.resumeAt,
        };
      }
      return {
        kind: observation.kind,
        invocationKey: observation.invocationKey,
        status: observation.status,
        ...(observation.output === undefined
          ? {}
          : { output: observation.output }),
        ...(observation.reasonCode === undefined
          ? {}
          : { reasonCode: observation.reasonCode }),
      };
    }),
    cursor: {
      expectedNextEventSequence: checkpoint.nextEventSequence,
      consumedThroughEventSequence:
        checkpoint.nextEventSequence + fresh.length - 1,
    },
    dueResumptions,
    ...(deadlineExpiration === undefined ? {} : { deadlineExpiration }),
  };
}

export interface AdvanceWorkflowInput {
  readonly runId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly checkpoint: unknown;
  readonly observations?: unknown;
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  readonly signal: AbortSignal;
}

function assertIdentity(
  value: string,
  label: string,
  code: 'attempt_invalid' | 'workflow_identity_invalid',
): void {
  if (value.length === 0 || value.length > 256)
    operationError(code, `${label} is invalid`);
}

function schedulerState(
  executable: CompiledWorkflowExecutableV2,
): SchedulerState {
  return {
    deriveReadiness: true,
    nodes: executable.envelope.graph.nodes.map(
      ({ id, disabled, sideEffectClass: pinnedSideEffectClass }) => ({
        id,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }),
    ),
    edges: executable.envelope.graph.edges.map(({ source, target }) => ({
      source: { nodeId: source.nodeId },
      target: { nodeId: target.nodeId },
    })),
  };
}

function assertCheckpointMatchesExecutable(
  checkpoint: ReturnType<typeof parseCheckpoint>,
  executable: CompiledWorkflowExecutableV2,
): void {
  if (checkpoint.joins.length !== 0 || checkpoint.loops.length !== 0)
    operationError(
      'workflow_identity_invalid',
      'checkpoint contains unsupported coordinator state',
    );
  const nodeIds = new Set(executable.envelope.graph.nodes.map(({ id }) => id));
  const invocationKeys = new Set<string>();
  for (const invocation of checkpoint.invocations) {
    if (
      !nodeIds.has(invocation.nodeId) ||
      invocation.invocationKey !==
        createInvocationKey({
          workflowVersionId: checkpoint.workflowVersionId,
          nodeId: invocation.nodeId,
        })
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint invocation does not belong to the executable graph',
      );
    invocationKeys.add(invocation.invocationKey);
  }
  if (
    checkpoint.admittedInvocationKeys.some(
      (invocationKey) => !invocationKeys.has(invocationKey),
    )
  )
    operationError(
      'workflow_identity_invalid',
      'checkpoint admission does not belong to an executable invocation',
    );
}

export async function advanceWorkflow(
  input: AdvanceWorkflowInput,
): Promise<WorkflowTransitionPlan> {
  assertAuthenticExecutableIdentity(input.executable);
  assertIdentity(input.runId, 'runId', 'workflow_identity_invalid');
  assertIdentity(
    input.workflowVersionId,
    'workflowVersionId',
    'workflow_identity_invalid',
  );
  await Promise.resolve();
  assertNotAborted(input.signal);
  const checkpoint = parseCheckpoint(input.checkpoint);
  if (checkpoint.workflowVersionId !== input.workflowVersionId)
    operationError(
      'workflow_identity_invalid',
      'checkpoint workflow version does not match executable identity',
    );
  assertCheckpointMatchesExecutable(checkpoint, input.executable);
  const persistedObservations = parseObservations(
    input.observations,
    checkpoint,
  );
  const plan = advanceWorkflowFromSchedulerState({
    checkpoint,
    schedulerState: schedulerState(input.executable),
    observations: persistedObservations.observations,
    ...(persistedObservations.deadlineExpiration === undefined
      ? {}
      : {
          deadlineExpiration: {
            occurredAt: persistedObservations.deadlineExpiration.occurredAt,
          },
        }),
    persistedObservationCursor: persistedObservations.cursor,
    dueResumptions: persistedObservations.dueResumptions,
    occurredAt: input.occurredAt,
    maximumAdmissions: input.maximumAdmissions,
  });
  assertNotAborted(input.signal);
  const providerKey = (
    nodeId: string,
    invocationKey: string,
  ): string | undefined => {
    const node = input.executable.envelope.graph.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    if (node?.sideEffectClass !== 'idempotent_with_key') return undefined;
    return providerIdempotencyKey({
      invocationKey,
      namespace: 'pertexo.node-attempt',
      operationIdentity: `${node.definition.key}@${String(node.definition.version)}`,
      runId: input.runId,
    });
  };
  return Object.freeze({
    ...plan,
    attempts: plan.attempts.map((attempt) => {
      const key = providerKey(attempt.nodeId, attempt.invocationKey);
      return Object.freeze({
        ...attempt,
        ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      });
    }),
    nodeRunAdmissions: plan.nodeRunAdmissions.map((admission) => {
      const key = providerKey(admission.nodeId, admission.invocationKey);
      return Object.freeze({
        ...admission,
        ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      });
    }),
  });
}

export interface NodeExecutionRegistry {
  readonly execute: (
    request: NodeExecutionRequest,
  ) => Promise<NodeExecutionResult>;
  readonly dispatchMode?: (
    request: Pick<NodeExecutionRequest, 'definition' | 'executor'>,
  ) => 'before_execute' | 'executor_controlled';
}

export interface ExecuteNodeAttemptInput {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly runInput: unknown;
  readonly completedNodeOutputs: unknown;
  readonly registry: NodeExecutionRegistry;
  readonly signal: AbortSignal;
  readonly runtime?: NodeExecutionRuntime;
}

export interface NodeAttemptOutcome {
  readonly runId: string;
  readonly nodeRunId: string;
  readonly attemptId: string;
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly kind: NodeExecutionResult['kind'];
  readonly output: NodeJsonValue;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    operationError('attempt_aborted', 'node attempt was aborted');
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof NodeExecutionAbortedError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function resolveMappedNodeInput(
  node: Pick<WorkflowExecutableNodeV2, 'definition' | 'inputMappings'>,
  runInput: JsonValue,
  completedOutputs: Readonly<Record<string, JsonValue>>,
  directUpstream: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<JsonValue> {
  if (node.definition.key === 'core.manual' && node.definition.version === 1)
    return runInput;
  const mapped: Record<string, JsonValue> = {};
  for (const key of Object.keys(node.inputMappings).sort()) {
    assertNotAborted(signal);
    const source = node.inputMappings[key];
    if (source === undefined) continue;
    if (
      source.kind === 'node_output' &&
      (!directUpstream.has(source.nodeId) ||
        !Object.hasOwn(completedOutputs, source.nodeId))
    )
      operationError(
        'attempt_invalid',
        'mapping upstream output is incomplete',
      );
    let resolution: ValueResolution;
    try {
      resolution = await resolveValueSource(
        source,
        { runInput, nodeOutputs: completedOutputs },
        undefined,
        signal,
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error))
        operationError('attempt_aborted', 'node attempt was aborted');
      operationError('attempt_invalid', 'mapping failed');
    }
    if (
      resolution.kind === 'error' &&
      (resolution.expression?.code === 'canceled' || signal.aborted)
    )
      operationError('attempt_aborted', 'node attempt was aborted');
    if (resolution.kind === 'error')
      operationError('attempt_invalid', 'mapping resolution failed');
    if (resolution.kind === 'value') mapped[key] = resolution.value;
  }
  try {
    return normalizeBoundedEngineJson(mapped);
  } catch {
    operationError('attempt_invalid', 'mapped input exceeds runtime limits');
  }
}

/** Resolve one isolated preview node through the production ValueSource path. */
export async function resolveSingleNodePreviewInput(
  input: Readonly<{
    node: unknown;
    runInput: unknown;
    signal: AbortSignal;
  }>,
): Promise<JsonValue> {
  let node: Pick<WorkflowExecutableNodeV2, 'definition' | 'inputMappings'>;
  let runInput: JsonValue;
  try {
    runInput = normalizeBoundedEngineJson(input.runInput);
    const rawNode = record(
      normalizeBoundedEngineJson(input.node),
      'attempt_invalid',
      'preview node',
    );
    const parsedNode = parseWorkflowGraphDraft({
      edges: [],
      nodes: [{ ...rawNode, position: { x: 0, y: 0 } }],
      schemaVersion: 1,
      settings: {},
    }).nodes[0];
    if (parsedNode === undefined)
      operationError('attempt_invalid', 'preview node is missing');
    node = parsedNode;
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'preview input is invalid',
    );
  }
  return resolveMappedNodeInput(
    node,
    runInput,
    Object.freeze({}),
    new Set(),
    input.signal,
  );
}

export async function executeNodeAttempt(
  input: ExecuteNodeAttemptInput,
): Promise<NodeAttemptOutcome> {
  assertAuthenticExecutableIdentity(input.executable);
  assertIdentity(input.runId, 'runId', 'attempt_invalid');
  assertIdentity(input.nodeRunId, 'nodeRunId', 'attempt_invalid');
  assertIdentity(input.attemptId, 'attemptId', 'attempt_invalid');
  assertIdentity(
    input.workflowVersionId,
    'workflowVersionId',
    'attempt_invalid',
  );
  assertNotAborted(input.signal);
  let runInput: JsonValue;
  let completed: JsonValue;
  try {
    runInput = normalizeBoundedEngineJson(input.runInput);
    completed = normalizeBoundedEngineJson(input.completedNodeOutputs);
  } catch (error) {
    operationError(
      'attempt_invalid',
      error instanceof Error ? error.message : 'attempt input is invalid',
    );
  }
  const completedOutputs = record(
    completed,
    'attempt_invalid',
    'completed outputs',
  );
  const node = input.executable.envelope.graph.nodes.find(
    ({ id }) => id === input.nodeId,
  );
  if (node === undefined || node.disabled)
    operationError('attempt_invalid', 'node is not executable');
  if (
    input.invocationKey !==
    createInvocationKey({
      workflowVersionId: input.workflowVersionId,
      nodeId: node.id,
    })
  )
    operationError(
      'attempt_invalid',
      'node invocation identity does not match',
    );
  const directUpstream = new Set(
    input.executable.envelope.graph.edges
      .filter(({ target }) => target.nodeId === node.id)
      .map(({ source }) => source.nodeId),
  );
  if (Object.keys(completedOutputs).some((key) => !directUpstream.has(key)))
    operationError(
      'attempt_invalid',
      'completed output is not direct upstream',
    );
  const resolvedInput = await resolveMappedNodeInput(
    node,
    runInput,
    completedOutputs,
    directUpstream,
    input.signal,
  );
  assertNotAborted(input.signal);
  let result: NodeExecutionResult;
  try {
    result = await input.registry.execute({
      definition: node.definition,
      executor: node.executor,
      config: node.config,
      input: resolvedInput,
      connectionRefs: node.connectionRefs,
      signal: input.signal,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    });
  } catch (error) {
    if (input.signal.aborted || isAbortError(error))
      operationError('attempt_aborted', 'node attempt was aborted');
    if (
      error instanceof Error &&
      (error as { decision?: { kind?: unknown } }).decision?.kind ===
        'outcome_unknown' &&
      (error as { possiblyDispatched?: unknown }).possiblyDispatched === true
    )
      throw error;
    operationError('attempt_invalid', 'node execution failed');
  }
  return {
    runId: input.runId,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    invocationKey: input.invocationKey,
    nodeId: node.id,
    kind: result.kind,
    output: result.output,
  };
}
