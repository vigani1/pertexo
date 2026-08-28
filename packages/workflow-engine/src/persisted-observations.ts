import type { JsonValue } from '@pertexo/workflow-model/canonical-json';

import type { WorkflowObservation } from './advance-workflow.js';
import type { parseCheckpoint } from './checkpoint.js';
import { normalizeBoundedEngineJson } from './executable-workflow.js';
import { exactKeys, operationError, record } from './operation-values.js';
import { compareOrdinal } from './ordering.js';
import type { OutputReference } from './types.js';

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

export const uuidPattern =
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
        exactKeys(
          observation,
          [
            'kind',
            'eventName',
            'sequence',
            'occurredAt',
            'invocationKey',
            'attemptId',
            'attemptNumber',
            'resumeAt',
            'waitKind',
          ],
          ['output'],
        );
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
          !isCanonicalTimestamp(observation.resumeAt) ||
          (observation.waitKind !== 'node_wait' &&
            observation.waitKind !== 'retry_backoff') ||
          (observation.waitKind === 'node_wait' &&
            (typeof observation.output !== 'object' ||
              observation.output === null ||
              Reflect.get(observation.output, 'kind') !== 'inline' ||
              Reflect.get(observation.output, 'attemptId') !==
                observation.attemptId)) ||
          (observation.waitKind === 'retry_backoff' &&
            observation.output !== undefined)
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
          waitKind: observation.waitKind,
          ...(observation.output === undefined
            ? {}
            : {
                output: {
                  kind: 'inline' as const,
                  attemptId: observation.attemptId,
                },
              }),
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
