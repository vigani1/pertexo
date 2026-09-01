import type { JsonValue } from '@pertexo/workflow-model/canonical-json';

import type { WorkflowObservation } from './types.js';
import { exactKeys, operationError, record } from './operation-values.js';
import type {
  AttemptFailureObservation,
  DeadlineExpiredObservation,
  DueAtObservation,
  PersistedWorkflowObservation,
} from './persisted-observations.js';

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

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
    uuidPattern.test(attemptId) &&
    typeof attemptNumber === 'number' &&
    Number.isSafeInteger(attemptNumber) &&
    attemptNumber > 0
  );
}

function parseSequencedCursor(observation: ObservationRecord): void {
  if (
    typeof observation.sequence !== 'number' ||
    !Number.isSafeInteger(observation.sequence) ||
    observation.sequence <= 0 ||
    !isCanonicalTimestamp(observation.occurredAt)
  ) {
    operationError('observation_invalid', 'observation cursor is invalid');
  }
}

function parseAttemptFailure(
  observation: ObservationRecord,
): AttemptFailureObservation {
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
  const failureKinds = ['failed', 'canceled', 'retry', 'outcome_unknown'];
  const errorKinds = [
    'authentication',
    'canceled',
    'configuration',
    'internal',
    'network',
    'provider',
    'rate_limit',
    'timeout',
  ];
  if (
    !isCanonicalTimestamp(observation.occurredAt) ||
    typeof observation.invocationKey !== 'string' ||
    !validAttempt(observation.attemptId, observation.attemptNumber) ||
    typeof observation.failureKind !== 'string' ||
    !failureKinds.includes(observation.failureKind) ||
    typeof observation.errorKind !== 'string' ||
    !errorKinds.includes(observation.errorKind) ||
    typeof observation.possiblyDispatched !== 'boolean' ||
    typeof observation.safeErrorCode !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(observation.safeErrorCode)
  ) {
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
    eventName: observation.eventName as 'node.started' | 'node.progress',
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
      Reflect.get(observation.output, 'attemptId') === observation.attemptId);
  const validRetryOutput =
    observation.waitKind !== 'retry_backoff' ||
    observation.output === undefined;
  if (
    !validEvent ||
    !validInvocationKey(observation.invocationKey) ||
    !validAttempt(observation.attemptId, observation.attemptNumber) ||
    !isCanonicalTimestamp(observation.resumeAt) ||
    !validWaitKind ||
    !validNodeWaitOutput ||
    !validRetryOutput
  ) {
    operationError('observation_invalid', 'wait observation is invalid');
  }
  return {
    kind: 'wait',
    eventName: observation.eventName as 'node.waiting' | 'node.retry_scheduled',
    sequence: observation.sequence as number,
    occurredAt: observation.occurredAt as string,
    invocationKey: observation.invocationKey,
    attemptId: observation.attemptId,
    attemptNumber: observation.attemptNumber as number,
    resumeAt: observation.resumeAt,
    waitKind: observation.waitKind as 'node_wait' | 'retry_backoff',
    ...(observation.output === undefined
      ? {}
      : {
          output: { kind: 'inline' as const, attemptId: observation.attemptId },
        }),
  };
}

function parseOutcomeOutput(
  value: JsonValue | undefined,
  attemptId: string,
): OutcomeOutput {
  if (value === undefined) return undefined;
  const candidate = record(value, 'observation_invalid', 'output reference');
  if (candidate.kind === 'inline') {
    exactKeys(candidate, ['kind', 'attemptId']);
    if (
      typeof candidate.attemptId !== 'string' ||
      !uuidPattern.test(candidate.attemptId) ||
      candidate.attemptId !== attemptId
    ) {
      operationError(
        'observation_invalid',
        'inline output must reference the completing attempt',
      );
    }
    return { kind: 'inline', attemptId: candidate.attemptId };
  }
  if (candidate.kind === 'artifact') {
    exactKeys(candidate, ['kind', 'artifactId']);
    if (
      typeof candidate.artifactId !== 'string' ||
      !uuidPattern.test(candidate.artifactId)
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
    !validAttempt(observation.attemptId, observation.attemptNumber) ||
    !isOutcomeStatus(observation.status)
  ) {
    operationError('observation_invalid', 'outcome observation is invalid');
  }
  if (
    observation.reasonCode !== undefined &&
    (typeof observation.reasonCode !== 'string' ||
      observation.reasonCode.length === 0 ||
      observation.reasonCode.length > 128)
  ) {
    operationError('observation_invalid', 'reasonCode is invalid');
  }
  const output = parseOutcomeOutput(observation.output, observation.attemptId);
  return {
    kind: 'outcome',
    sequence: observation.sequence as number,
    occurredAt: observation.occurredAt as string,
    attemptId: observation.attemptId,
    attemptNumber: observation.attemptNumber as number,
    invocationKey: observation.invocationKey,
    status: observation.status as Extract<
      PersistedWorkflowObservation,
      { kind: 'outcome' }
    >['status'],
    ...(output === undefined ? {} : { output }),
    ...(observation.reasonCode === undefined
      ? {}
      : { reasonCode: observation.reasonCode as string }),
  };
}

export function parsePersistedObservation(value: JsonValue): ParsedObservation {
  const observation = record(value, 'observation_invalid', 'observation');
  switch (observation.kind) {
    case 'attempt_failure':
      return parseAttemptFailure(observation);
    case 'deadline_expired':
      return parseDeadlineExpired(observation);
    case 'due_at':
      return parseDueAt(observation);
    default:
      parseSequencedCursor(observation);
  }
  switch (observation.kind) {
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
        'observation kind is unsupported in Phase 3',
      );
  }
}
