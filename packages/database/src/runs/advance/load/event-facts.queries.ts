import type { nodeRuns } from '../../../schema/runs/execution.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { artifacts } from '../../../schema/transport.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';

import { CoordinatorRunStateCorruptError } from '../contract.js';
import {
  parseStoredExecutionValue,
  storedExecutionValuesEqual,
} from '../../../platform/stored-execution-value.js';
import type { CoordinatorEventRow } from './attempts.queries.js';
import {
  record,
  eventPayloadRecord,
  canonicalTimestamp,
  eventIdentity,
} from './fact-admission.js';

export type EventRow = CoordinatorEventRow;

const terminalStatuses: Readonly<
  Record<string, typeof nodeRuns.$inferSelect.status | undefined>
> = {
  'node.succeeded': 'succeeded',
  'node.failed': 'failed',
  'node.canceled': 'canceled',
  'node.timed_out': 'timed_out',
  'node.outcome_unknown': 'outcome_unknown',
};
export function terminalStatus(type: string) {
  return terminalStatuses[type];
}

function attemptFact(
  row: EventRow,
  eventPayload?: Readonly<Record<string, unknown>>,
): Readonly<{
  attemptId: string;
  attemptNumber: number;
  invocationKey: string;
}> {
  const payload = eventIdentity(
    eventPayload ?? eventPayloadRecord(row.payload),
  );
  const invalidAttemptIdentity =
    row.attempt_id !== payload.attemptId ||
    row.node_run_id !== payload.nodeRunId ||
    row.current_attempt_id !== payload.attemptId ||
    row.attempt_number === null ||
    row.attempt_number <= 0 ||
    row.invocation_key === null;
  if (invalidAttemptIdentity) throw new CoordinatorRunStateCorruptError();
  return {
    attemptId: payload.attemptId,
    attemptNumber: row.attempt_number,
    invocationKey: row.invocation_key,
  };
}

export function mapEvent(row: EventRow): unknown {
  const payload = eventPayloadRecord(row.payload);
  const occurredAt = new Date(row.created_at).toISOString();
  if (row.type === 'run.cancel_requested')
    return { kind: 'cancel_requested', sequence: row.sequence, occurredAt };
  if (row.type === 'node.started' || row.type === 'node.progress') {
    return cursorEventFact(row, { payload, occurredAt });
  }
  if (row.type === 'node.waiting' || row.type === 'node.retry_scheduled') {
    return waitingEventFact(row, { payload, occurredAt });
  }
  return outcomeEventFact(row, { payload, occurredAt });
}

export function completedInlineOutput(
  row: EventRow,
  controlOutputNodeIds: ReadonlySet<string>,
): readonly unknown[] {
  const ignoresControlOutput =
    row.type !== 'node.succeeded' ||
    row.attempt_output_ref === null ||
    row.node_id === null ||
    !controlOutputNodeIds.has(row.node_id);
  if (ignoresControlOutput) return [];
  const identity = attemptFact(row);
  let stored;
  try {
    stored = parseStoredExecutionValue(row.attempt_output_ref);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  return stored.kind === 'inline'
    ? [
        {
          sequence: row.sequence,
          attemptId: identity.attemptId,
          invocationKey: identity.invocationKey,
          value: stored.value,
        },
      ]
    : [];
}

/** Artifact outputs the engine will reference must still be stored. */
export async function assertAvailableArtifacts(
  client: PoolClient,
  workspaceId: string,
  observations: readonly unknown[],
): Promise<void> {
  const artifactIds = new Set(
    observations.flatMap((observation) => {
      const output = record(observation).output;
      if (output === undefined) return [];
      const value = record(output);
      return value.kind === 'artifact' && typeof value.artifactId === 'string'
        ? [value.artifactId]
        : [];
    }),
  );
  if (artifactIds.size === 0) return;
  const available = await drizzle(client)
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        inArray(artifacts.id, [...artifactIds]),
        eq(artifacts.status, 'available'),
        isNull(artifacts.deletedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  if (available.length !== artifactIds.size)
    throw new CoordinatorRunStateCorruptError();
}

type EventContext = Readonly<{
  payload: Readonly<Record<string, unknown>>;
  occurredAt: string;
}>;
function cursorEventFact(
  row: EventRow,
  { payload, occurredAt }: EventContext,
): unknown {
  const physicalStatusIsCoherent =
    row.attempt_status === row.node_status ||
    (row.attempt_status === 'failed' &&
      row.node_status === 'running' &&
      row.executor_failure_kind !== null &&
      row.retry_decision === 'pending') ||
    (row.node_status === 'waiting' &&
      (row.attempt_status === 'succeeded' || row.attempt_status === 'failed'));
  const invalidAttemptStatus =
    row.attempt_status === null ||
    !physicalStatusIsCoherent ||
    ![
      'running',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ].includes(row.attempt_status);
  if (invalidAttemptStatus) throw new CoordinatorRunStateCorruptError();
  return {
    kind: 'cursor_only',
    eventName: row.type,
    sequence: row.sequence,
    occurredAt,
    ...attemptFact(row, payload),
  };
}
function waitingEventFact(
  row: EventRow,
  { payload, occurredAt }: EventContext,
): unknown {
  const resumeAt = canonicalTimestamp(payload.dueAt);
  const persistedDueAt =
    row.type === 'node.waiting' ? row.resume_at : row.retry_due_at;
  const invalidWaitingEvidence =
    row.attempt_status !==
      (row.type === 'node.waiting' ? 'succeeded' : 'failed') ||
    row.node_status !== 'waiting' ||
    !storedExecutionValuesEqual(row.attempt_output_ref, row.node_output_ref) ||
    persistedDueAt?.toISOString() !== resumeAt;
  if (invalidWaitingEvidence) throw new CoordinatorRunStateCorruptError();
  return {
    kind: 'wait',
    eventName: row.type,
    sequence: row.sequence,
    occurredAt,
    resumeAt,
    waitKind: row.type === 'node.waiting' ? 'node_wait' : 'retry_backoff',
    ...(row.type !== 'node.waiting' || row.attempt_id === null
      ? {}
      : { output: { kind: 'inline' as const, attemptId: row.attempt_id } }),
    ...attemptFact(row, payload),
  };
}
function outcomeEventFact(
  row: EventRow,
  { payload, occurredAt }: EventContext,
): unknown {
  const status = terminalStatus(row.type);
  if (status === undefined) throw new CoordinatorRunStateCorruptError();
  const identity = attemptFact(row, payload);
  const invalidCompletionEvidence =
    row.attempt_status !== status ||
    row.node_status !== status ||
    !storedExecutionValuesEqual(row.attempt_output_ref, row.node_output_ref);
  if (invalidCompletionEvidence) throw new CoordinatorRunStateCorruptError();
  let output: unknown;
  if (row.attempt_output_ref !== null) {
    let stored;
    try {
      stored = parseStoredExecutionValue(row.attempt_output_ref);
    } catch {
      throw new CoordinatorRunStateCorruptError();
    }
    output =
      stored.kind === 'inline'
        ? { kind: 'inline', attemptId: identity.attemptId }
        : { kind: 'artifact', artifactId: stored.artifactId };
  }
  return {
    kind: 'outcome',
    sequence: row.sequence,
    occurredAt,
    status,
    ...identity,
    ...(output === undefined ? {} : { output }),
    ...(typeof payload.safeErrorCode === 'string'
      ? { reasonCode: payload.safeErrorCode }
      : {}),
  };
}
