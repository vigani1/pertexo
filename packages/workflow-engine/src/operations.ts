import {
  NodeExecutionAbortedError,
  NodeExecutorFailure,
  type JsonValue as NodeJsonValue,
  type NodeExecutionRequest,
  type NodeExecutionResult,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import {
  canonicalJson,
  type JsonValue,
} from '@pertexo/workflow-model/canonical-json';
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
  type WorkflowExecutableGraphV2,
} from './executable-workflow.js';
import { parseCheckpoint } from './checkpoint.js';
import {
  configuredBranchOutputPorts,
  configuredParallelOutputPorts,
  configuredScopedOutputPorts,
  type SchedulerState,
} from './graph-scheduler.js';
import { compareOrdinal } from './ordering.js';
import {
  decideRetry,
  providerIdempotencyKey,
  resolveRetryPolicy,
} from './retries.js';
import { invocationKey as createInvocationKey } from './scheduling.js';
import type {
  BranchScopePart,
  IterationScopePart,
  JoinPolicy,
  OutputReference,
  WorkflowTransitionPlan,
} from './types.js';

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
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
  code: 'observation_invalid' | 'attempt_invalid' = 'observation_invalid',
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  )
    operationError(code, 'observation fields are invalid');
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

export type AttemptFailureObservation = Readonly<{
  readonly kind: 'attempt_failure';
  readonly occurredAt: string;
  readonly invocationKey: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly failureKind: 'failed' | 'canceled' | 'retry' | 'outcome_unknown';
  readonly errorKind:
    | 'authentication'
    | 'canceled'
    | 'configuration'
    | 'internal'
    | 'network'
    | 'provider'
    | 'rate_limit'
    | 'timeout';
  readonly possiblyDispatched: boolean;
  readonly safeErrorCode: string;
}>;

type ParsedPersistedObservations = Readonly<{
  observations: readonly WorkflowObservation[];
  deadlineExpiration?: DeadlineExpiredObservation;
  dueResumptions: readonly DueAtObservation[];
  attemptFailures: readonly AttemptFailureObservation[];
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
  const declaredLoop = checkpoint.loops.find(
    ({ controlInvocationKey }) =>
      controlInvocationKey === observation.invocationKey,
  );
  return (
    invocation?.attemptNumber === observation.attemptNumber &&
    (invocation.status === observation.status ||
      (observation.status === 'succeeded' &&
        declaredLoop !== undefined &&
        (invocation.status === 'waiting' ||
          invocation.status === 'succeeded'))) &&
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
    | PersistedWorkflowObservation
    | DeadlineExpiredObservation
    | DueAtObservation
    | AttemptFailureObservation
  )[] = items.map(
    (
      item,
    ):
      | PersistedWorkflowObservation
      | DeadlineExpiredObservation
      | DueAtObservation
      | AttemptFailureObservation => {
      const observation = record(item, 'observation_invalid', 'observation');
      if (observation.kind === 'attempt_failure') {
        exactKeys(observation, [
          'kind',
          'occurredAt',
          'invocationKey',
          'attemptId',
          'attemptNumber',
          'failureKind',
          'errorKind',
          'possiblyDispatched',
          'safeErrorCode',
        ]);
        if (
          !isCanonicalTimestamp(observation.occurredAt) ||
          typeof observation.invocationKey !== 'string' ||
          typeof observation.attemptId !== 'string' ||
          !uuidPattern.test(observation.attemptId) ||
          typeof observation.attemptNumber !== 'number' ||
          !Number.isSafeInteger(observation.attemptNumber) ||
          observation.attemptNumber <= 0 ||
          typeof observation.failureKind !== 'string' ||
          !['failed', 'canceled', 'retry', 'outcome_unknown'].includes(
            observation.failureKind,
          ) ||
          typeof observation.errorKind !== 'string' ||
          ![
            'authentication',
            'canceled',
            'configuration',
            'internal',
            'network',
            'provider',
            'rate_limit',
            'timeout',
          ].includes(observation.errorKind) ||
          typeof observation.possiblyDispatched !== 'boolean' ||
          typeof observation.safeErrorCode !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(
            observation.safeErrorCode,
          )
        )
          operationError('observation_invalid', 'attempt failure is invalid');
        return observation as AttemptFailureObservation;
      }
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
  const attemptFailures: AttemptFailureObservation[] = [];
  const sequenced: PersistedWorkflowObservation[] = [];
  for (const observation of parsed) {
    if (observation.kind === 'attempt_failure') {
      if (
        attemptFailures.some(
          (failure) =>
            failure.invocationKey === observation.invocationKey ||
            failure.attemptId === observation.attemptId,
        )
      )
        operationError('observation_invalid', 'attempt failures conflict');
      attemptFailures.push(observation);
      continue;
    }
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
    attemptFailures,
    ...(deadlineExpiration === undefined ? {} : { deadlineExpiration }),
  };
}

export interface AdvanceWorkflowInput {
  readonly runId: string;
  readonly executable: CompiledWorkflowExecutableV2;
  readonly workflowVersionId: string;
  readonly checkpoint: unknown;
  readonly observations?: unknown;
  readonly completedOutputs?: unknown;
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
  readonly signal: AbortSignal;
}

function completedOutputReference(
  outcome: Readonly<Record<string, JsonValue>>,
  attemptId: string,
): OutputReference | undefined {
  const output = outcome.output;
  if (!isJsonRecord(output)) return undefined;
  if (output.kind === 'inline' && output.attemptId === attemptId)
    return { kind: 'inline', attemptId };
  if (
    output.kind === 'artifact' &&
    typeof output.artifactId === 'string' &&
    uuidPattern.test(output.artifactId)
  )
    return { kind: 'artifact', artifactId: output.artifactId };
  return undefined;
}

function branchSelectionObservations(
  value: unknown,
  persistedValue: unknown,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  executable: CompiledWorkflowExecutableV2,
): readonly WorkflowObservation[] {
  if (value === undefined) return [];
  let normalized: JsonValue;
  let persisted: JsonValue;
  try {
    normalized = normalizeBoundedEngineJson(value);
    persisted = normalizeBoundedEngineJson(persistedValue ?? []);
  } catch {
    operationError('observation_invalid', 'completed outputs are invalid');
  }
  if (!Array.isArray(normalized) || !Array.isArray(persisted))
    operationError('observation_invalid', 'completed outputs must be an array');
  const completedItems = normalized as readonly JsonValue[];
  const persistedItems = persisted as readonly JsonValue[];
  const seen = new Map<string, string>();
  return completedItems.flatMap((item): WorkflowObservation[] => {
    const material = record(item, 'observation_invalid', 'completed output');
    exactKeys(material, ['sequence', 'attemptId', 'invocationKey', 'value']);
    if (
      typeof material.sequence !== 'number' ||
      !Number.isSafeInteger(material.sequence) ||
      material.sequence < 1 ||
      typeof material.attemptId !== 'string' ||
      !uuidPattern.test(material.attemptId) ||
      typeof material.invocationKey !== 'string'
    )
      operationError(
        'observation_invalid',
        'completed output identity is invalid',
      );
    const attemptId = material.attemptId;
    const identity = `${String(material.sequence)}\u0000${material.attemptId}`;
    const canonicalMaterial = canonicalJson(material);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      if (previous !== canonicalMaterial)
        operationError('observation_invalid', 'completed output conflicts');
      return [];
    }
    seen.set(identity, canonicalMaterial);
    const correspondingOutcome = persistedItems.some((candidate) => {
      if (!isJsonRecord(candidate)) return false;
      return (
        candidate.kind === 'outcome' &&
        candidate.sequence === material.sequence &&
        candidate.attemptId === material.attemptId &&
        candidate.invocationKey === material.invocationKey &&
        candidate.status === 'succeeded' &&
        completedOutputReference(candidate, attemptId) !== undefined
      );
    });
    if (!correspondingOutcome)
      operationError(
        'observation_invalid',
        'completed output has no matching persisted outcome',
      );
    const invocation = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === material.invocationKey,
    );
    const node = executableNodes(executable.envelope.graph).find(
      ({ id }) => id === invocation?.nodeId,
    );
    if (node === undefined) return [];
    const parallelPorts = configuredParallelOutputPorts(node);
    if (parallelPorts !== undefined) {
      if (material.value === undefined)
        operationError('observation_invalid', 'Parallel output is missing');
      const completedValue = record(
        material.value,
        'observation_invalid',
        'Parallel output',
      );
      exactKeys(completedValue, ['branchIds']);
      if (
        !Array.isArray(completedValue.branchIds) ||
        completedValue.branchIds.length !== parallelPorts.length ||
        completedValue.branchIds.some(
          (branchId, index) => branchId !== parallelPorts[index],
        )
      )
        operationError('observation_invalid', 'Parallel output is invalid');
      return [];
    }
    const outputPorts = configuredBranchOutputPorts(node);
    if (outputPorts === undefined) return [];
    const completedValue = material.value;
    if (completedValue === undefined)
      operationError('observation_invalid', 'branch output is missing');
    const output = record(
      completedValue,
      'observation_invalid',
      'branch output',
    );
    exactKeys(output, ['selectedPort']);
    if (
      typeof output.selectedPort !== 'string' ||
      !outputPorts.includes(output.selectedPort)
    )
      operationError('observation_invalid', 'branch output is invalid');
    return [
      {
        kind: 'branch_selected',
        invocationKey: material.invocationKey,
        nodeId: node.id,
        selectedOutputPort: output.selectedPort,
        coordinatorDerived: true,
      },
    ];
  });
}

function forEachCoordinatorObservations(
  value: unknown,
  persistedValue: unknown,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  executable: CompiledWorkflowExecutableV2,
  derivedObservations: readonly WorkflowObservation[] = [],
): Readonly<{
  observations: readonly WorkflowObservation[];
  declarationInvocationKeys: ReadonlySet<string>;
}> {
  let completed: JsonValue;
  let persisted: JsonValue;
  try {
    completed = normalizeBoundedEngineJson(value ?? []);
    persisted = normalizeBoundedEngineJson(persistedValue ?? []);
  } catch {
    operationError('observation_invalid', 'completed outputs are invalid');
  }
  if (!Array.isArray(completed) || !Array.isArray(persisted))
    operationError('observation_invalid', 'completed outputs must be an array');
  const completedItems = completed as readonly JsonValue[];
  const persistedItems = persisted as readonly JsonValue[];
  const nodes = new Map(
    executableNodes(executable.envelope.graph).map((node) => [node.id, node]),
  );
  const declarations = new Set<string>();
  const declarationMaterials = new Map<string, string>();
  const observations: WorkflowObservation[] = [];
  const terminalOutcomes = new Map<
    string,
    | 'succeeded'
    | 'skipped'
    | 'failed'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown'
  >();
  for (const candidate of persistedItems) {
    if (
      isJsonRecord(candidate) &&
      candidate.kind === 'outcome' &&
      typeof candidate.invocationKey === 'string' &&
      typeof candidate.status === 'string' &&
      [
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ].includes(candidate.status)
    )
      terminalOutcomes.set(
        candidate.invocationKey,
        candidate.status as
          'succeeded' | 'failed' | 'canceled' | 'timed_out' | 'outcome_unknown',
      );
  }
  for (const candidate of derivedObservations) {
    if (candidate.kind === 'outcome' && candidate.status !== 'skipped')
      terminalOutcomes.set(candidate.invocationKey, candidate.status);
  }
  for (const item of completedItems) {
    const material = record(item, 'observation_invalid', 'completed output');
    exactKeys(material, ['sequence', 'attemptId', 'invocationKey', 'value']);
    if (
      typeof material.sequence !== 'number' ||
      !Number.isSafeInteger(material.sequence) ||
      typeof material.attemptId !== 'string' ||
      !uuidPattern.test(material.attemptId) ||
      typeof material.invocationKey !== 'string'
    )
      operationError(
        'observation_invalid',
        'completed output identity is invalid',
      );
    const outcome = persistedItems.find(
      (candidate) =>
        isJsonRecord(candidate) &&
        candidate.kind === 'outcome' &&
        candidate.sequence === material.sequence &&
        candidate.attemptId === material.attemptId &&
        candidate.invocationKey === material.invocationKey &&
        candidate.status === 'succeeded',
    );
    if (!isJsonRecord(outcome))
      operationError(
        'observation_invalid',
        'completed output has no matching persisted outcome',
      );
    const invocation = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === material.invocationKey,
    );
    const node = nodes.get(invocation?.nodeId ?? '');
    if (
      invocation === undefined ||
      node?.definition.key !== 'core.foreach' ||
      node.definition.version !== 1 ||
      node.structured?.kind !== 'for_each'
    )
      continue;
    const canonicalMaterial = canonicalJson(material);
    const previousMaterial = declarationMaterials.get(invocation.invocationKey);
    if (previousMaterial !== undefined) {
      if (previousMaterial !== canonicalMaterial)
        operationError(
          'observation_invalid',
          'For Each declaration output conflicts',
        );
      continue;
    }
    declarationMaterials.set(invocation.invocationKey, canonicalMaterial);
    if (material.value === undefined)
      operationError('observation_invalid', 'For Each output is missing');
    const output = record(
      material.value,
      'observation_invalid',
      'For Each output',
    );
    exactKeys(output, ['items', 'iterationCount']);
    if (
      !Array.isArray(output.items) ||
      typeof output.iterationCount !== 'number' ||
      !Number.isSafeInteger(output.iterationCount) ||
      output.iterationCount !== output.items.length
    )
      operationError('observation_invalid', 'For Each output is invalid');
    const body = node.structured.body;
    const targets = new Set(body.edges.map(({ target }) => target.nodeId));
    const sources = new Set(body.edges.map(({ source }) => source.nodeId));
    const roots = body.nodes
      .map(({ id }) => id)
      .filter((id) => !targets.has(id))
      .sort(compareOrdinal);
    const sinks = body.nodes
      .map(({ id }) => id)
      .filter((id) => !sources.has(id));
    const outputReference = completedOutputReference(
      outcome,
      material.attemptId,
    );
    if (outputReference === undefined)
      operationError(
        'observation_invalid',
        'For Each output reference is invalid',
      );
    declarations.add(invocation.invocationKey);
    observations.push({
      kind: 'loop_started',
      loopId: node.id,
      controlInvocationKey: invocation.invocationKey,
      branchPath: invocation.branchPath ?? [],
      iterationPath: invocation.iterationPath ?? [],
      bodyRootNodeIds: roots,
      bodySinkNodeId: sinks[0] ?? '',
      collection: outputReference,
      collectionChecksum: createHash('sha256')
        .update(canonicalJson(output.items))
        .digest('hex'),
      collectionSize: output.items.length,
      maxIterations: node.structured.maxIterations,
      maxConcurrency: node.structured.maxConcurrency,
      coordinatorDerived: true,
    });
  }
  for (const loop of checkpoint.loops) {
    for (const ordinal of loop.activeOrdinals) {
      const iterationPath = [
        ...loop.iterationPath,
        { loopNodeId: loop.loopId, ordinal },
      ];
      const sinkKey = createInvocationKey({
        workflowVersionId: checkpoint.workflowVersionId,
        nodeId: loop.bodySinkNodeId,
        branchPath: loop.branchPath.map(
          ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
        ),
        iterationPath,
      });
      const failedInvocation = checkpoint.invocations.find(
        (invocation) =>
          JSON.stringify(invocation.iterationPath ?? []) ===
            JSON.stringify(iterationPath) &&
          ['failed', 'canceled', 'timed_out', 'outcome_unknown'].includes(
            terminalOutcomes.get(invocation.invocationKey) ?? '',
          ),
      );
      const terminalInvocationKey = failedInvocation?.invocationKey ?? sinkKey;
      const checkpointSink = checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === sinkKey,
      );
      const terminalStatus =
        terminalOutcomes.get(terminalInvocationKey) ??
        (checkpointSink?.status === 'skipped' ? 'skipped' : undefined);
      if (terminalStatus === undefined) continue;
      observations.push({
        kind: 'loop_iteration_completed',
        loopId: loop.loopId,
        controlInvocationKey: loop.controlInvocationKey,
        ...(failedInvocation === undefined
          ? {}
          : { invocationKey: failedInvocation.invocationKey }),
        ordinal,
        status: terminalStatus,
        coordinatorDerived: true,
      });
    }
  }
  observations.sort((left, right) => {
    const leftKey =
      left.kind === 'loop_started' || left.kind === 'loop_iteration_completed'
        ? `${left.controlInvocationKey ?? left.loopId}:${left.kind === 'loop_started' ? '0' : '1'}:${left.kind === 'loop_iteration_completed' ? String(left.ordinal).padStart(16, '0') : ''}`
        : '';
    const rightKey =
      right.kind === 'loop_started' || right.kind === 'loop_iteration_completed'
        ? `${right.controlInvocationKey ?? right.loopId}:${right.kind === 'loop_started' ? '0' : '1'}:${right.kind === 'loop_iteration_completed' ? String(right.ordinal).padStart(16, '0') : ''}`
        : '';
    return compareOrdinal(leftKey, rightKey);
  });
  return { observations, declarationInvocationKeys: declarations };
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
  const projectGraph = (graph: WorkflowExecutableGraphV2): SchedulerState => ({
    deriveReadiness: true,
    nodes: graph.nodes.map(
      ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }) => ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }),
    ),
    edges: graph.edges.map(({ source, target }) => ({
      source: { nodeId: source.nodeId, port: source.port },
      target: { nodeId: target.nodeId, port: target.port },
    })),
    structuredBodies: graph.nodes.flatMap((node) =>
      node.structured === undefined
        ? []
        : [
            {
              loopNodeId: node.id,
              ...projectGraph(node.structured.body),
            },
            ...(projectGraph(node.structured.body).structuredBodies ?? []),
          ],
    ),
  });
  return projectGraph(executable.envelope.graph);
}

function executableNodes(
  graph: WorkflowExecutableGraphV2,
): readonly WorkflowExecutableNodeV2[] {
  return graph.nodes.flatMap((node) => [
    node,
    ...(node.structured === undefined
      ? []
      : executableNodes(node.structured.body)),
  ]);
}

function executableEdges(
  graph: WorkflowExecutableGraphV2,
): readonly WorkflowExecutableGraphV2['edges'][number][] {
  return [
    ...graph.edges,
    ...graph.nodes.flatMap((node) =>
      node.structured === undefined
        ? []
        : executableEdges(node.structured.body),
    ),
  ];
}

function assertCheckpointMatchesExecutable(
  checkpoint: ReturnType<typeof parseCheckpoint>,
  executable: CompiledWorkflowExecutableV2,
): void {
  const allNodes = executableNodes(executable.envelope.graph);
  const nodeIds = new Set(allNodes.map(({ id }) => id));
  const nodesById = new Map(allNodes.map((node) => [node.id, node]));
  for (const join of checkpoint.joins) {
    const merge = nodesById.get(join.joinId);
    if (
      merge?.definition.key !== 'core.merge' ||
      merge.definition.version !== 1
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint join does not belong to a Merge node',
      );
    const parallelNodeId = Reflect.get(
      merge.config,
      'parallelNodeId',
    ) as unknown;
    const parallel =
      typeof parallelNodeId === 'string'
        ? nodesById.get(parallelNodeId)
        : undefined;
    const branchIds =
      parallel === undefined
        ? undefined
        : configuredParallelOutputPorts(parallel);
    if (branchIds === undefined)
      operationError(
        'workflow_identity_invalid',
        'checkpoint join disagrees with its paired Parallel',
      );
    if (
      join.ledger.length !== branchIds.length ||
      join.ledger.some(({ branchId }) => !branchIds.includes(branchId))
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint join disagrees with its paired Parallel',
      );
    const expectedJoinKey = createInvocationKey({
      workflowVersionId: checkpoint.workflowVersionId,
      nodeId: join.joinId,
      branchPath: (join.branchPath ?? []).map(
        ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
      ),
      ...(join.iterationPath === undefined
        ? {}
        : { iterationPath: join.iterationPath }),
    });
    if (
      join.joinInvocationKey !== expectedJoinKey &&
      !(
        join.joinInvocationKey === join.joinId &&
        (join.branchPath?.length ?? 0) === 0 &&
        (join.iterationPath?.length ?? 0) === 0
      )
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint join scope is invalid',
      );
  }
  const invocationKeys = new Set<string>();
  for (const invocation of checkpoint.invocations) {
    const branchPath = invocation.branchPath ?? [];
    const ancestors = structuredAncestors(
      executable.envelope.graph,
      invocation.nodeId,
    );
    if (
      !nodeIds.has(invocation.nodeId) ||
      ancestors?.length !== (invocation.iterationPath?.length ?? 0) ||
      ancestors.some(
        (loopNodeId, index) =>
          invocation.iterationPath?.[index]?.loopNodeId !== loopNodeId,
      ) ||
      branchPath.some(({ nodeId, outputPort }) => {
        const node = nodesById.get(nodeId);
        const outputPorts =
          node === undefined ? undefined : configuredScopedOutputPorts(node);
        return !outputPorts?.includes(outputPort);
      }) ||
      invocation.invocationKey !==
        createInvocationKey({
          workflowVersionId: checkpoint.workflowVersionId,
          nodeId: invocation.nodeId,
          branchPath: branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
          ...(invocation.iterationPath === undefined
            ? {}
            : { iterationPath: invocation.iterationPath }),
        })
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint invocation does not belong to the executable graph',
      );
    for (const [index, scope] of (invocation.iterationPath ?? []).entries()) {
      const enclosingPath = invocation.iterationPath?.slice(0, index) ?? [];
      const declaredLoop = checkpoint.loops.find(
        (loop) =>
          loop.loopId === scope.loopNodeId &&
          JSON.stringify(loop.iterationPath) ===
            JSON.stringify(enclosingPath) &&
          loop.branchPath.every((part, branchIndex) => {
            const invocationPart = branchPath[branchIndex];
            return (
              invocationPart?.nodeId === part.nodeId &&
              invocationPart.outputPort === part.outputPort
            );
          }),
      );
      if (
        declaredLoop === undefined ||
        (!declaredLoop.activeOrdinals.includes(scope.ordinal) &&
          !declaredLoop.terminalOrdinals.includes(scope.ordinal))
      )
        operationError(
          'workflow_identity_invalid',
          'checkpoint invocation iteration scope is not active in its declared loop',
        );
    }
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
  for (const loop of checkpoint.loops) {
    const node = nodesById.get(loop.loopId);
    if (
      node?.definition.key !== 'core.foreach' ||
      node.definition.version !== 1 ||
      node.structured?.kind !== 'for_each' ||
      loop.controlInvocationKey !==
        createInvocationKey({
          workflowVersionId: checkpoint.workflowVersionId,
          nodeId: loop.loopId,
          branchPath: loop.branchPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
          iterationPath: loop.iterationPath,
        })
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint loop does not belong to its scoped For Each control',
      );
    const body = node.structured.body;
    const targets = new Set(body.edges.map(({ target }) => target.nodeId));
    const sources = new Set(body.edges.map(({ source }) => source.nodeId));
    const expectedRoots = body.nodes
      .map(({ id }) => id)
      .filter((id) => !targets.has(id))
      .sort(compareOrdinal);
    const expectedSink = body.nodes.find(({ id }) => !sources.has(id))?.id;
    if (
      loop.maxIterations !== node.structured.maxIterations ||
      loop.maxConcurrency !== node.structured.maxConcurrency ||
      loop.bodyRootNodeIds.length !== expectedRoots.length ||
      loop.bodyRootNodeIds.some((id, index) => id !== expectedRoots[index]) ||
      loop.bodySinkNodeId !== expectedSink
    )
      operationError(
        'workflow_identity_invalid',
        'checkpoint loop topology or bounds disagree with the executable',
      );
  }
}

function mergeCoordinatorObservations(
  executable: CompiledWorkflowExecutableV2,
  checkpoint: ReturnType<typeof parseCheckpoint>,
  observations: readonly WorkflowObservation[],
): readonly WorkflowObservation[] {
  const projected = new Map(
    checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const observation of observations) {
    if (observation.kind !== 'outcome') continue;
    const invocation = projected.get(observation.invocationKey);
    if (invocation === undefined) continue;
    projected.set(observation.invocationKey, {
      ...invocation,
      status: observation.status,
      ...(observation.output === undefined
        ? {}
        : { output: observation.output }),
    });
  }
  const nodes = new Map(
    executableNodes(executable.envelope.graph).map((node) => [node.id, node]),
  );
  const edges = executableEdges(executable.envelope.graph);
  return [...nodes.values()]
    .filter(
      ({ definition }) =>
        definition.key === 'core.merge' && definition.version === 1,
    )
    .flatMap((merge): WorkflowObservation[] => {
      const parallelNodeId = Reflect.get(
        merge.config,
        'parallelNodeId',
      ) as unknown;
      const policy = Reflect.get(merge.config, 'policy') as unknown;
      if (
        typeof parallelNodeId !== 'string' ||
        typeof policy !== 'object' ||
        policy === null
      )
        operationError('workflow_identity_invalid', 'Merge config is invalid');
      const parallel = nodes.get(parallelNodeId);
      const branchIds =
        parallel === undefined
          ? undefined
          : configuredParallelOutputPorts(parallel);
      if (branchIds === undefined)
        operationError('workflow_identity_invalid', 'Merge pairing is invalid');
      const parallelInvocations = [...projected.values()].filter(
        (invocation) =>
          invocation.nodeId === parallelNodeId &&
          invocation.status === 'succeeded',
      );
      return parallelInvocations.flatMap(
        (parallelInvocation): WorkflowObservation[] => {
          const joinInvocationKey = createInvocationKey({
            workflowVersionId: checkpoint.workflowVersionId,
            nodeId: merge.id,
            branchPath: (parallelInvocation.branchPath ?? []).map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
            ...(parallelInvocation.iterationPath === undefined
              ? {}
              : { iterationPath: parallelInvocation.iterationPath }),
          });
          const declared: WorkflowObservation = {
            kind: 'join_declared',
            joinId: merge.id,
            joinInvocationKey,
            branchPath: parallelInvocation.branchPath ?? [],
            iterationPath: parallelInvocation.iterationPath ?? [],
            policy: policy as JoinPolicy,
            branchIds,
            coordinatorDerived: true,
          };
          const dispositions = branchIds.flatMap(
            (branchId): WorkflowObservation[] => {
              const expectedBranchPath = [
                ...(parallelInvocation.branchPath ?? []),
                { nodeId: parallelNodeId, outputPort: branchId },
              ];
              const scoped = [...projected.values()].filter(
                (invocation) =>
                  JSON.stringify(invocation.iterationPath ?? []) ===
                    JSON.stringify(parallelInvocation.iterationPath ?? []) &&
                  expectedBranchPath.every((part, index) => {
                    const candidatePart = invocation.branchPath?.[index];
                    return (
                      candidatePart?.nodeId === part.nodeId &&
                      candidatePart.outputPort === part.outputPort
                    );
                  }),
              );
              if (
                scoped.length === 0 ||
                scoped.some(({ status }) =>
                  ['pending', 'ready', 'running', 'waiting'].includes(status),
                )
              )
                return [];
              const mergeSourceNodeId = edges.find(
                ({ target }) =>
                  target.nodeId === merge.id && target.port === branchId,
              )?.source.nodeId;
              const source = scoped.find(
                ({ nodeId }) => nodeId === mergeSourceNodeId,
              );
              const statuses = new Set(scoped.map(({ status }) => status));
              const disposition =
                statuses.has('failed') ||
                statuses.has('timed_out') ||
                statuses.has('outcome_unknown')
                  ? 'failed'
                  : statuses.has('canceled')
                    ? 'canceled'
                    : statuses.size === 1 && statuses.has('skipped')
                      ? 'skipped'
                      : 'arrived';
              return [
                {
                  kind: 'branch_disposition',
                  joinId: merge.id,
                  joinInvocationKey,
                  coordinatorDerived: true,
                  branch: {
                    branchId,
                    disposition,
                    ...(disposition === 'arrived' &&
                    source?.output !== undefined
                      ? { output: source.output }
                      : {}),
                  },
                },
              ];
            },
          );
          return [declared, ...dispositions];
        },
      );
    });
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
  const branchSelections = branchSelectionObservations(
    input.completedOutputs,
    input.observations,
    checkpoint,
    input.executable,
  );
  const controlCanceled =
    checkpoint.cancelRequested ||
    persistedObservations.observations.some(
      (observation) => observation.kind === 'cancel_requested',
    );
  const controlDeadline =
    checkpoint.deadlineExpired ||
    persistedObservations.deadlineExpiration !== undefined;
  const retryPolicyReference = input.executable.envelope.runtimePolicies.retry;
  let retryPolicy: ReturnType<typeof resolveRetryPolicy>;
  try {
    retryPolicy = resolveRetryPolicy(retryPolicyReference);
  } catch {
    operationError('workflow_identity_invalid', 'retry policy is unsupported');
  }
  const resolvedFailures: WorkflowObservation[] =
    persistedObservations.attemptFailures.map((failure) => {
      const invocation = checkpoint.invocations.find(
        (candidate) => candidate.invocationKey === failure.invocationKey,
      );
      const node = executableNodes(input.executable.envelope.graph).find(
        (candidate) => candidate.id === invocation?.nodeId,
      );
      if (
        invocation?.status !== 'running' ||
        invocation.attemptNumber !== failure.attemptNumber ||
        node === undefined
      )
        operationError('observation_invalid', 'attempt failure is stale');
      const unsafeUnknown =
        node.sideEffectClass === 'unsafe' &&
        failure.possiblyDispatched &&
        failure.failureKind !== 'failed';
      if (controlCanceled || controlDeadline) {
        return {
          kind: 'outcome',
          invocationKey: failure.invocationKey,
          status: unsafeUnknown
            ? 'outcome_unknown'
            : controlCanceled
              ? 'canceled'
              : 'timed_out',
          reasonCode: failure.safeErrorCode,
          coordinatorDerived: true,
        };
      }
      if (failure.failureKind === 'canceled') {
        return {
          kind: 'outcome',
          invocationKey: failure.invocationKey,
          status: unsafeUnknown ? 'outcome_unknown' : 'canceled',
          reasonCode: failure.safeErrorCode,
          coordinatorDerived: true,
        };
      }
      const decision = decideRetry({
        sideEffectClass: node.sideEffectClass,
        currentAttemptNumber: failure.attemptNumber,
        policy: retryPolicy,
        observation: {
          kind: 'executor_failure',
          recommendation: failure.failureKind,
          errorKind: failure.errorKind,
          possiblyDispatched: failure.possiblyDispatched,
        },
        jitterIdentity: `${input.runId}\u0000${failure.invocationKey}\u0000${String(failure.attemptNumber)}\u0000${retryPolicyReference.key}@${String(retryPolicyReference.version)}`,
      });
      if (decision.kind === 'retry') {
        return {
          kind: 'wait',
          invocationKey: failure.invocationKey,
          resumeAt: new Date(
            Date.parse(failure.occurredAt) + decision.delayMs,
          ).toISOString(),
          coordinatorDerived: true,
        };
      }
      return {
        kind: 'outcome',
        invocationKey: failure.invocationKey,
        status:
          decision.kind === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
        reasonCode: failure.safeErrorCode,
        coordinatorDerived: true,
      };
    });
  const forEach = forEachCoordinatorObservations(
    input.completedOutputs,
    input.observations,
    checkpoint,
    input.executable,
    resolvedFailures,
  );
  const executionObservations = persistedObservations.observations.map(
    (observation): WorkflowObservation =>
      observation.kind === 'outcome' &&
      forEach.declarationInvocationKeys.has(observation.invocationKey)
        ? { kind: 'cursor_only' }
        : observation,
  );
  const coordinatorObservations = mergeCoordinatorObservations(
    input.executable,
    checkpoint,
    [...executionObservations, ...resolvedFailures],
  );
  const plan = advanceWorkflowFromSchedulerState({
    checkpoint,
    schedulerState: schedulerState(input.executable),
    observations: [
      ...executionObservations,
      ...branchSelections,
      ...resolvedFailures,
      ...forEach.observations,
      ...coordinatorObservations,
    ],
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
    const node = executableNodes(input.executable.envelope.graph).find(
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
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
  readonly structuredCollection?: Readonly<{
    readonly loopNodeId: string;
    readonly ordinal: number;
    readonly collection: unknown;
    readonly collectionSize: number;
    readonly declaredCollectionChecksum: string;
  }>;
  readonly runInput: unknown;
  readonly completedNodeOutputs: unknown;
  readonly coordinatorInput?: unknown;
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
  structuredInputs?: Readonly<Record<string, JsonValue>>,
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
        {
          runInput,
          nodeOutputs: completedOutputs,
          ...(structuredInputs === undefined ? {} : { structuredInputs }),
        },
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
    undefined,
  );
}

function graphContainingNode(
  graph: WorkflowExecutableGraphV2,
  nodeId: string,
): WorkflowExecutableGraphV2 | undefined {
  if (graph.nodes.some(({ id }) => id === nodeId)) return graph;
  for (const node of graph.nodes) {
    if (node.structured === undefined) continue;
    const found = graphContainingNode(node.structured.body, nodeId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function structuredAncestors(
  graph: WorkflowExecutableGraphV2,
  nodeId: string,
  ancestors: readonly string[] = [],
): readonly string[] | undefined {
  if (graph.nodes.some(({ id }) => id === nodeId)) return ancestors;
  for (const node of graph.nodes) {
    if (node.structured === undefined) continue;
    const found = structuredAncestors(node.structured.body, nodeId, [
      ...ancestors,
      node.id,
    ]);
    if (found !== undefined) return found;
  }
  return undefined;
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
  const node = executableNodes(input.executable.envelope.graph).find(
    ({ id }) => id === input.nodeId,
  );
  if (node === undefined || node.disabled)
    operationError('attempt_invalid', 'node is not executable');
  const ancestors = structuredAncestors(
    input.executable.envelope.graph,
    node.id,
  );
  if (
    ancestors?.length !== (input.iterationPath?.length ?? 0) ||
    ancestors.some(
      (loopNodeId, index) =>
        input.iterationPath?.[index]?.loopNodeId !== loopNodeId,
    )
  )
    operationError(
      'attempt_invalid',
      'node invocation structured scope does not match the executable',
    );
  if (
    input.invocationKey !==
    createInvocationKey({
      workflowVersionId: input.workflowVersionId,
      nodeId: node.id,
      ...(input.branchPath === undefined
        ? {}
        : {
            branchPath: input.branchPath.map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
          }),
      ...(input.iterationPath === undefined
        ? {}
        : { iterationPath: input.iterationPath }),
    })
  )
    operationError(
      'attempt_invalid',
      'node invocation identity does not match',
    );
  const containingGraph = graphContainingNode(
    input.executable.envelope.graph,
    node.id,
  );
  if (containingGraph === undefined)
    operationError('attempt_invalid', 'node graph is missing');
  const directUpstream = new Set(
    containingGraph.edges
      .filter(({ target }) => target.nodeId === node.id)
      .map(({ source }) => source.nodeId),
  );
  const completedOutputs: Record<string, JsonValue> = {};
  if (Array.isArray(completed)) {
    for (const candidate of completed as readonly JsonValue[]) {
      const descriptor = record(
        candidate,
        'attempt_invalid',
        'completed output',
      );
      exactKeys(
        descriptor,
        ['invocationKey', 'nodeId', 'value'],
        [],
        'attempt_invalid',
      );
      const upstreamEdge = containingGraph.edges.find(
        ({ source, target }) =>
          source.nodeId === descriptor.nodeId && target.nodeId === node.id,
      );
      const branchPath = input.branchPath ?? [];
      const nearestBranch = branchPath.at(-1);
      const upstreamBranchPath =
        upstreamEdge !== undefined &&
        nearestBranch?.nodeId === descriptor.nodeId &&
        nearestBranch?.outputPort === upstreamEdge.source.port
          ? branchPath.slice(0, -1)
          : branchPath;
      if (
        typeof descriptor.nodeId !== 'string' ||
        typeof descriptor.invocationKey !== 'string' ||
        !directUpstream.has(descriptor.nodeId) ||
        upstreamEdge === undefined ||
        descriptor.invocationKey !==
          createInvocationKey({
            workflowVersionId: input.workflowVersionId,
            nodeId: descriptor.nodeId,
            branchPath: upstreamBranchPath.map(
              ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
            ),
            ...(input.iterationPath === undefined
              ? {}
              : { iterationPath: input.iterationPath }),
          })
      )
        operationError(
          'attempt_invalid',
          'completed output invocation is not exact upstream',
        );
      if (descriptor.value === undefined)
        operationError('attempt_invalid', 'completed output value is missing');
      completedOutputs[descriptor.nodeId] = descriptor.value;
    }
  } else {
    if ((input.iterationPath?.length ?? 0) > 0)
      operationError(
        'attempt_invalid',
        'scoped completed outputs require invocation descriptors',
      );
    const legacy = record(completed, 'attempt_invalid', 'completed outputs');
    for (const [nodeId, value] of Object.entries(legacy)) {
      if (!directUpstream.has(nodeId))
        operationError(
          'attempt_invalid',
          'completed output is not direct upstream',
        );
      completedOutputs[nodeId] = value;
    }
  }
  let structuredInputs: Readonly<Record<string, JsonValue>> | undefined;
  if (input.iterationPath !== undefined) {
    const nearest = input.iterationPath.at(-1);
    const proof = input.structuredCollection;
    if (proof === undefined || nearest === undefined)
      operationError(
        'attempt_invalid',
        'structured collection proof is missing',
      );
    let collection: JsonValue;
    try {
      collection = normalizeBoundedEngineJson(proof.collection);
    } catch {
      operationError('attempt_invalid', 'structured collection is invalid');
    }
    if (!Array.isArray(collection))
      operationError(
        'attempt_invalid',
        'structured collection must be an array',
      );
    const items = collection as readonly JsonValue[];
    if (
      proof.loopNodeId !== nearest.loopNodeId ||
      !Number.isSafeInteger(proof.ordinal) ||
      proof.ordinal !== nearest.ordinal ||
      !Number.isSafeInteger(proof.collectionSize) ||
      proof.collectionSize !== items.length ||
      nearest.ordinal < 0 ||
      nearest.ordinal >= items.length ||
      typeof proof.declaredCollectionChecksum !== 'string' ||
      createHash('sha256').update(canonicalJson(items)).digest('hex') !==
        proof.declaredCollectionChecksum
    )
      operationError(
        'attempt_invalid',
        'structured collection proof is invalid',
      );
    const item: JsonValue | undefined = items[nearest.ordinal];
    if (item === undefined)
      operationError(
        'attempt_invalid',
        'structured collection item is missing',
      );
    structuredInputs = { item, ordinal: nearest.ordinal };
  }
  const resolvedInput = await resolveMappedNodeInput(
    node.definition.key === 'core.merge' && node.definition.version === 1
      ? { ...node, inputMappings: {} }
      : node,
    runInput,
    completedOutputs,
    directUpstream,
    input.signal,
    structuredInputs,
  );
  let executionInput = resolvedInput;
  if (node.definition.key === 'core.merge' && node.definition.version === 1) {
    if (input.coordinatorInput === undefined)
      operationError('attempt_invalid', 'settled Merge input is missing');
    try {
      executionInput = normalizeBoundedEngineJson(input.coordinatorInput);
    } catch {
      operationError('attempt_invalid', 'settled Merge input is invalid');
    }
  }
  assertNotAborted(input.signal);
  let result: NodeExecutionResult;
  try {
    result = await input.registry.execute({
      definition: node.definition,
      executor: node.executor,
      config: node.config,
      input: executionInput,
      connectionRefs: node.connectionRefs,
      signal: input.signal,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    });
  } catch (error) {
    if (input.signal.aborted || isAbortError(error))
      operationError('attempt_aborted', 'node attempt was aborted');
    if (error instanceof NodeExecutorFailure) throw error;
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
import { createHash } from 'node:crypto';
