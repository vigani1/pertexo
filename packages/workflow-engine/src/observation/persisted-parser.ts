import {
  MAXIMUM_RETRY_DELAY_MILLIS,
  NODE_EXECUTOR_ERROR_KINDS,
  NODE_EXECUTOR_FAILURE_KINDS,
} from '@pertexo/node-sdk/server';
import { UUID_PATTERN } from '@pertexo/workflow-model';
import {
  isSafeExecutorErrorCode,
  type JsonValue,
} from '@pertexo/workflow-model';

import type { WorkflowObservation } from '../types.js';
import { exactKeys, operationError, record } from '../operation-values.js';
import type {
  AttemptFailureObservation,
  DeadlineExpiredObservation,
  DueAtObservation,
  PersistedWorkflowObservation,
} from './persisted.js';

type ParsedObservation =
  | PersistedWorkflowObservation
  | DeadlineExpiredObservation
  | DueAtObservation
  | AttemptFailureObservation;
type ObservationRecord = Readonly<Record<string, JsonValue>>;
type OutcomeOutput = Extract<
  WorkflowObservation,
  { readonly kind: 'outcome' }
>['output'];

function includesValue(values: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && values.includes(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 35) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function validInvocationKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validAttempt(
  attemptId: unknown,
  attemptNumber: unknown,
): attemptId is string {
  return (
    typeof attemptId === 'string' &&
    UUID_PATTERN.test(attemptId) &&
    typeof attemptNumber === 'number' &&
    Number.isSafeInteger(attemptNumber) &&
    attemptNumber > 0
  );
}

function parseSequencedCursor(observation: ObservationRecord): void {
  const invalidCursor =
    typeof observation.sequence !== 'number' ||
    !Number.isSafeInteger(observation.sequence) ||
    observation.sequence <= 0 ||
    !isCanonicalTimestamp(observation.occurredAt);
  if (invalidCursor) {
    operationError('observation_invalid', 'observation cursor is invalid');
  }
}

function parseAttemptFailure(
  observation: ObservationRecord,
): AttemptFailureObservation {
  exactKeys(
    observation,
    [
      'kind',
      'occurredAt',
      'invocationKey',
      'attemptId',
      'attemptNumber',
      'failureKind',
      'errorKind',
      'possiblyDispatched',
      'safeErrorCode',
    ],
    ['minimumRetryDelayMillis'],
  );
  const invalidFailureIdentity =
    !isCanonicalTimestamp(observation.occurredAt) ||
    typeof observation.invocationKey !== 'string' ||
    !validAttempt(observation.attemptId, observation.attemptNumber) ||
    !includesValue(NODE_EXECUTOR_FAILURE_KINDS, observation.failureKind) ||
    !includesValue(NODE_EXECUTOR_ERROR_KINDS, observation.errorKind) ||
    typeof observation.possiblyDispatched !== 'boolean' ||
    !isSafeExecutorErrorCode(observation.safeErrorCode) ||
    (observation.minimumRetryDelayMillis !== undefined &&
      (typeof observation.minimumRetryDelayMillis !== 'number' ||
        !Number.isInteger(observation.minimumRetryDelayMillis) ||
        observation.minimumRetryDelayMillis < 0 ||
        observation.minimumRetryDelayMillis > MAXIMUM_RETRY_DELAY_MILLIS));
  if (invalidFailureIdentity) {
    operationError('observation_invalid', 'attempt failure is invalid');
  }
  return observation as AttemptFailureObservation;
}

function parseDeadlineExpired(
  observation: ObservationRecord,
): DeadlineExpiredObservation {
  exactKeys(observation, ['kind', 'occurredAt']);
  if (!isCanonicalTimestamp(observation.occurredAt)) {
    operationError('observation_invalid', 'deadline timestamp is invalid');
  }
  return { kind: 'deadline_expired', occurredAt: observation.occurredAt };
}

function parseDueAt(observation: ObservationRecord): DueAtObservation {
  exactKeys(observation, ['kind', 'occurredAt', 'invocationKey']);
  if (
    !isCanonicalTimestamp(observation.occurredAt) ||
    !validInvocationKey(observation.invocationKey)
  ) {
    operationError('observation_invalid', 'due observation is invalid');
  }
  return {
    kind: 'due_at',
    occurredAt: observation.occurredAt,
    invocationKey: observation.invocationKey,
  };
}

function parseCancellation(
  observation: ObservationRecord,
): PersistedWorkflowObservation {
  exactKeys(observation, ['kind', 'sequence', 'occurredAt']);
  return {
    kind: 'cancel_requested',
    sequence: observation.sequence as number,
    occurredAt: observation.occurredAt as string,
  };
}

function parseCursorOnly(
  observation: ObservationRecord,
): PersistedWorkflowObservation {
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
  ) {
    operationError('observation_invalid', 'cursor event name is invalid');
  }
  if (
    !validInvocationKey(observation.invocationKey) ||
    !validAttempt(observation.attemptId, observation.attemptNumber)
  ) {
    operationError('observation_invalid', 'cursor event is invalid');
  }
  return {
    kind: 'cursor_only',
    eventName: observation.eventName,
    sequence: observation.sequence as number,
    occurredAt: observation.occurredAt as string,
    invocationKey: observation.invocationKey,
    attemptId: observation.attemptId,
    attemptNumber: observation.attemptNumber as number,
  };
}

function parseWait(
  observation: ObservationRecord,
): PersistedWorkflowObservation {
  const { invocationKey, attemptId, resumeAt } = observation;

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
  const validEvent =
    observation.eventName === 'node.waiting' ||
    observation.eventName === 'node.retry_scheduled';
  const validWaitKind =
    observation.waitKind === 'node_wait' ||
    observation.waitKind === 'retry_backoff';
  const validNodeWaitOutput =
    observation.waitKind !== 'node_wait' ||
    (typeof observation.output === 'object' &&
      observation.output !== null &&
      Reflect.get(observation.output, 'kind') === 'inline' &&
      Reflect.get(observation.output, 'attemptId') === attemptId);
  const validRetryOutput =
    observation.waitKind !== 'retry_backoff' ||
    observation.output === undefined;
  const invalidWait =
    !validEvent ||
    !validInvocationKey(invocationKey) ||
    !validAttempt(attemptId, observation.attemptNumber) ||
    !isCanonicalTimestamp(resumeAt) ||
    !validWaitKind ||
    !validNodeWaitOutput ||
    !validRetryOutput;
  if (invalidWait) {
    operationError('observation_invalid', 'wait observation is invalid');
  }
  return {
    kind: 'wait',
    eventName: observation.eventName as 'node.waiting' | 'node.retry_scheduled',
    sequence: observation.sequence as number,
    occurredAt: observation.occurredAt as string,
    invocationKey: invocationKey,
    attemptId: attemptId,
    attemptNumber: observation.attemptNumber as number,
    resumeAt: resumeAt,
    waitKind: observation.waitKind as 'node_wait' | 'retry_backoff',
    ...(observation.output === undefined
      ? {}
      : {
          output: { kind: 'inline' as const, attemptId: attemptId },
        }),
  };
}

function parseOutcomeOutput(
  value: JsonValue | undefined,
  attemptId: string,
): OutcomeOutput {
  if (value === undefined) return undefined;
  const candidate = record(value, 'observation_invalid', 'output reference');
  const { attemptId: referenceAttemptId } = candidate;

  if (candidate.kind === 'inline') {
    exactKeys(candidate, ['kind', 'attemptId']);
    const invalidAttemptReference =
      typeof referenceAttemptId !== 'string' ||
      !UUID_PATTERN.test(referenceAttemptId) ||
      referenceAttemptId !== attemptId;
    if (invalidAttemptReference) {
      operationError(
        'observation_invalid',
        'inline output must reference the completing attempt',
      );
    }
    return { kind: 'inline', attemptId: referenceAttemptId };
  }
  if (candidate.kind === 'artifact') {
    exactKeys(candidate, ['kind', 'artifactId']);
    if (
      typeof candidate.artifactId !== 'string' ||
      !UUID_PATTERN.test(candidate.artifactId)
    ) {
      operationError('observation_invalid', 'artifact output is invalid');
    }
    return { kind: 'artifact', artifactId: candidate.artifactId };
  }
  operationError('observation_invalid', 'output reference kind is invalid');
}

function isOutcomeStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    [
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ].includes(value)
  );
}

function parseOutcome(
  observation: ObservationRecord,
): PersistedWorkflowObservation {
  const { invocationKey, attemptId, reasonCode } = observation;

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
  const invalidOutcome =
    typeof invocationKey !== 'string' ||
    !validAttempt(attemptId, observation.attemptNumber) ||
    !isOutcomeStatus(observation.status);
  if (invalidOutcome) {
    operationError('observation_invalid', 'outcome observation is invalid');
  }
  const invalidReasonCode =
    reasonCode !== undefined &&
    (typeof reasonCode !== 'string' ||
      reasonCode.length === 0 ||
      reasonCode.length > 128);
  if (invalidReasonCode) {
    operationError('observation_invalid', 'reasonCode is invalid');
  }
  const output = parseOutcomeOutput(observation.output, attemptId);
  return {
    kind: 'outcome',
    sequence: observation.sequence as number,
    occurredAt: observation.occurredAt as string,
    attemptId: attemptId,
    attemptNumber: observation.attemptNumber as number,
    invocationKey: invocationKey,
    status: observation.status as Extract<
      PersistedWorkflowObservation,
      { kind: 'outcome' }
    >['status'],
    ...(output === undefined ? {} : { output }),
    ...(reasonCode === undefined ? {} : { reasonCode: reasonCode }),
  };
}

export function parsePersistedObservation(value: JsonValue): ParsedObservation {
  const observation = record(value, 'observation_invalid', 'observation');
  const kind = typeof observation.kind === 'string' ? observation.kind : '';
  switch (kind) {
    case 'attempt_failure':
      return parseAttemptFailure(observation);
    case 'deadline_expired':
      return parseDeadlineExpired(observation);
    case 'due_at':
      return parseDueAt(observation);
    default:
      parseSequencedCursor(observation);
  }
  switch (kind) {
    case 'cancel_requested':
      return parseCancellation(observation);
    case 'cursor_only':
      return parseCursorOnly(observation);
    case 'wait':
      return parseWait(observation);
    case 'outcome':
      return parseOutcome(observation);
    default:
      operationError(
        'observation_invalid',
        'observation kind is unsupported by the baseline engine',
      );
  }
}
