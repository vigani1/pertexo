import type { JsonValue } from '@pertexo/workflow-model/canonical-json';

import type { parseCheckpoint } from './checkpoint.js';
import { normalizeBoundedEngineJson } from './executable-workflow.js';
import { operationError } from './operation-values.js';
import { compareOrdinal } from './ordering.js';
import { parsePersistedObservation } from './persisted-observation-parser.js';
import type { OutputReference, WorkflowObservation } from './types.js';

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
        readonly waitKind: 'node_wait' | 'retry_backoff';
        readonly output?: OutputReference;
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

export type ParsedPersistedObservations = Readonly<{
  observations: readonly WorkflowObservation[];
  deadlineExpiration?: DeadlineExpiredObservation;
  dueResumptions: readonly DueAtObservation[];
  attemptFailures: readonly AttemptFailureObservation[];
  cursor: Readonly<{
    expectedNextEventSequence: number;
    consumedThroughEventSequence: number;
  }>;
}>;

export { uuidPattern } from './persisted-observation-parser.js';

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
      left.resumeAt === right.resumeAt &&
      left.waitKind === right.waitKind &&
      left.output?.kind === right.output?.kind &&
      (left.output?.kind === 'inline' && right.output?.kind === 'inline'
        ? left.output.attemptId === right.output.attemptId
        : left.output === undefined && right.output === undefined)
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
      invocation.resumeAt === observation.resumeAt &&
      invocation.waitKind === observation.waitKind
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

export function parsePersistedObservations(
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
  const parsed = items.map(parsePersistedObservation);
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
          waitKind: observation.waitKind,
          ...(observation.output === undefined
            ? {}
            : { output: observation.output }),
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
