import type { PoolClient } from 'pg';
import { WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1 } from '@pertexo/workflow-model/observation-window';
import { CoordinatorRunStateCorruptError } from './coordinator-run-store-contract.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from '../stored-execution-value.js';
import {
  attachPhysicalAttempts,
  readPhysicalAttempts,
  type CoordinatorEventRow,
  type PersistedCoordinatorEventRow,
} from './coordinator-run-store-fact-physical-state.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumCanonicalEventPayloadBytes =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.canonicalFactBytes;
export const maximumPersistedFacts =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.facts;
const maximumCanonicalPersistedFactBytes =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.canonicalWindowBytes;
// Keep each result bounded while avoiding a long-lived coordinator snapshot
// spending hundreds of network round trips on the accepted observation window.
const maximumPersistedFactRowsPerFetch = 1_000;
// This is a materialization target, not a protocol limit. A single accepted
// PostgreSQL JSON value may exceed it after numeric text expansion.
const targetPersistedFactWirePageBytes = 4 * 1_024 * 1_024;

function normalizedJson(value: unknown): unknown {
  try {
    return JSON.parse(serializeStoredExecutionJsonValue(value)) as unknown;
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  const normalized = normalizedJson(value);
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    throw new CoordinatorRunStateCorruptError();
  return normalized as Readonly<Record<string, unknown>>;
}

function canonicalEventPayload(value: unknown): Readonly<{
  bytes: number;
  payload: Readonly<Record<string, unknown>>;
}> {
  let serialized: string;
  try {
    serialized = serializeStoredExecutionJsonValue(value);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maximumCanonicalEventPayloadBytes)
    throw new CoordinatorRunStateCorruptError();
  const normalized = JSON.parse(serialized) as unknown;
  if (
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    throw new CoordinatorRunStateCorruptError();
  return Object.freeze({
    bytes,
    payload: normalized as Readonly<Record<string, unknown>>,
  });
}

function eventPayloadRecord(value: unknown): Readonly<Record<string, unknown>> {
  return canonicalEventPayload(value).payload;
}

export async function persistedFactCapacity(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  firstSequence: number,
  lastSequence?: number,
): Promise<
  Readonly<{
    count: number;
    maximumStorageBytes: number;
    storageBytes: number;
  }>
> {
  const result = await client.query<{
    fact_count: number;
    maximum_storage_bytes: string;
    storage_bytes: string;
  }>(
    `select count(*)::int as fact_count,
            coalesce(sum(octet_length(payload::text)),0)::bigint as storage_bytes,
            coalesce(max(octet_length(payload::text)),0)::bigint
              as maximum_storage_bytes
     from app.run_events
     where workspace_id=$1 and workflow_run_id=$2 and sequence >= $3
       and ($4::int is null or sequence <= $4::int)`,
    [workspaceId, runId, firstSequence, lastSequence ?? null],
  );
  const row = result.rows[0];
  const count = row?.fact_count;
  const storageBytes = Number(row?.storage_bytes);
  const maximumStorageBytes = Number(row?.maximum_storage_bytes);
  if (
    count === undefined ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(storageBytes) ||
    !Number.isSafeInteger(maximumStorageBytes) ||
    count < 0 ||
    storageBytes < 0 ||
    maximumStorageBytes < 0 ||
    maximumStorageBytes > storageBytes
  )
    throw new CoordinatorRunStateCorruptError();
  return Object.freeze({ count, maximumStorageBytes, storageBytes });
}

export function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new CoordinatorRunStateCorruptError();
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    throw new CoordinatorRunStateCorruptError();
  return value;
}

function eventIdentity(payload: Readonly<Record<string, unknown>>): Readonly<{
  attemptId: string;
  nodeRunId: string;
}> {
  if (
    typeof payload.attemptId !== 'string' ||
    !uuidPattern.test(payload.attemptId) ||
    typeof payload.nodeRunId !== 'string' ||
    !uuidPattern.test(payload.nodeRunId)
  )
    throw new CoordinatorRunStateCorruptError();
  return { attemptId: payload.attemptId, nodeRunId: payload.nodeRunId };
}

type EventRow = CoordinatorEventRow;

export async function readPersistedFacts(
  client: PoolClient,
  input: Readonly<{
    count: number;
    firstSequence: number;
    lastSequence?: number;
    maximumStorageBytes: number;
    runId: string;
    workspaceId: string;
  }>,
): Promise<readonly EventRow[]> {
  const persistedEvents: PersistedCoordinatorEventRow[] = [];
  const identitiesBySequence = new Map<
    number,
    Readonly<{ attemptId: string; nodeRunId: string }>
  >();
  const attemptIds = new Set<string>();
  let canonicalBytes = 0;
  let nextSequence = input.firstSequence;
  const rowsPerFetch = Math.min(
    maximumPersistedFactRowsPerFetch,
    Math.max(
      1,
      Math.floor(
        targetPersistedFactWirePageBytes /
          Math.max(1, input.maximumStorageBytes),
      ),
    ),
  );
  while (persistedEvents.length < input.count) {
    const result = await client.query<PersistedCoordinatorEventRow>(
      `select event.sequence, event.type, event.payload, event.created_at
       from app.run_events event
       where event.workspace_id=$1 and event.workflow_run_id=$2
         and event.sequence >= $3
         and ($4::int is null or event.sequence <= $4::int)
       order by event.sequence
       limit $5`,
      [
        input.workspaceId,
        input.runId,
        nextSequence,
        input.lastSequence ?? null,
        rowsPerFetch,
      ],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const canonical = canonicalEventPayload(row.payload);
      canonicalBytes += canonical.bytes;
      if (canonicalBytes > maximumCanonicalPersistedFactBytes)
        throw new CoordinatorRunStateCorruptError();
      const event = Object.freeze({ ...row, payload: canonical.payload });
      persistedEvents.push(event);
      if (row.type !== 'run.cancel_requested') {
        const identity = eventIdentity(canonical.payload);
        identitiesBySequence.set(row.sequence, identity);
        attemptIds.add(identity.attemptId);
      }
      nextSequence = row.sequence + 1;
    }
  }
  const physicalByAttemptId = await readPhysicalAttempts(
    client,
    input.workspaceId,
    input.runId,
    [...attemptIds],
  );
  return attachPhysicalAttempts(
    persistedEvents,
    identitiesBySequence,
    physicalByAttemptId,
  );
}

export function terminalStatus(type: string): string | undefined {
  return (
    {
      'node.succeeded': 'succeeded',
      'node.failed': 'failed',
      'node.canceled': 'canceled',
      'node.timed_out': 'timed_out',
      'node.outcome_unknown': 'outcome_unknown',
    } as Readonly<Record<string, string>>
  )[type];
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
  if (
    row.attempt_id !== payload.attemptId ||
    row.node_run_id !== payload.nodeRunId ||
    row.current_attempt_id !== payload.attemptId ||
    row.attempt_number === null ||
    row.attempt_number <= 0 ||
    row.invocation_key === null
  )
    throw new CoordinatorRunStateCorruptError();
  return {
    attemptId: payload.attemptId,
    attemptNumber: row.attempt_number,
    invocationKey: row.invocation_key,
  };
}

function requiredLaterFactType(row: EventRow): string | undefined {
  if (row.node_status === 'waiting') {
    if (row.attempt_status === 'succeeded') return 'node.waiting';
    if (row.attempt_status === 'failed') return 'node.retry_scheduled';
    return undefined;
  }
  return row.attempt_status === row.node_status && row.node_status !== null
    ? `node.${row.node_status}`
    : undefined;
}
export function validatePersistedFactBatch(rows: readonly EventRow[]): void {
  const laterTypesByAttempt = new Map<string, Set<string>>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) throw new CoordinatorRunStateCorruptError();
    if (
      (row.type !== 'node.started' && row.type !== 'node.progress') ||
      (row.attempt_status === 'running' && row.node_status === 'running') ||
      (row.attempt_status === 'failed' &&
        row.node_status === 'running' &&
        row.executor_failure_kind !== null &&
        row.retry_decision === 'pending')
    ) {
      if (row.attempt_id !== null) {
        const types =
          laterTypesByAttempt.get(row.attempt_id) ?? new Set<string>();
        types.add(row.type);
        laterTypesByAttempt.set(row.attempt_id, types);
      }
      continue;
    }
    const requiredLaterType = requiredLaterFactType(row);
    if (
      row.attempt_id === null ||
      requiredLaterType === undefined ||
      !laterTypesByAttempt.get(row.attempt_id)?.has(requiredLaterType)
    )
      throw new CoordinatorRunStateCorruptError();
    const types = laterTypesByAttempt.get(row.attempt_id) ?? new Set<string>();
    types.add(row.type);
    laterTypesByAttempt.set(row.attempt_id, types);
  }
}

export function mapEvent(row: EventRow): unknown {
  const payload = eventPayloadRecord(row.payload);
  if (payload.schemaVersion !== 1) throw new CoordinatorRunStateCorruptError();
  const occurredAt = new Date(row.created_at).toISOString();
  if (row.type === 'run.cancel_requested')
    return { kind: 'cancel_requested', sequence: row.sequence, occurredAt };
  if (row.type === 'node.started' || row.type === 'node.progress') {
    const physicalStatusIsCoherent =
      row.attempt_status === row.node_status ||
      (row.attempt_status === 'failed' &&
        row.node_status === 'running' &&
        row.executor_failure_kind !== null &&
        row.retry_decision === 'pending') ||
      (row.node_status === 'waiting' &&
        (row.attempt_status === 'succeeded' ||
          row.attempt_status === 'failed'));
    if (
      row.attempt_status === null ||
      !physicalStatusIsCoherent ||
      ![
        'running',
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ].includes(row.attempt_status)
    )
      throw new CoordinatorRunStateCorruptError();
    return {
      kind: 'cursor_only',
      eventName: row.type,
      sequence: row.sequence,
      occurredAt,
      ...attemptFact(row, payload),
    };
  }
  if (row.type === 'node.waiting' || row.type === 'node.retry_scheduled') {
    const resumeAt = canonicalTimestamp(payload.dueAt);
    const persistedDueAt =
      row.type === 'node.waiting' ? row.resume_at : row.retry_due_at;
    if (
      row.attempt_status !==
        (row.type === 'node.waiting' ? 'succeeded' : 'failed') ||
      row.node_status !== 'waiting' ||
      serializeStoredExecutionJsonValue(row.attempt_output_ref) !==
        serializeStoredExecutionJsonValue(row.node_output_ref) ||
      persistedDueAt?.toISOString() !== resumeAt
    )
      throw new CoordinatorRunStateCorruptError();
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
  const status = terminalStatus(row.type);
  if (status === undefined) throw new CoordinatorRunStateCorruptError();
  const identity = attemptFact(row, payload);
  if (
    row.attempt_status !== status ||
    row.node_status !== status ||
    serializeStoredExecutionJsonValue(row.attempt_output_ref) !==
      serializeStoredExecutionJsonValue(row.node_output_ref)
  )
    throw new CoordinatorRunStateCorruptError();
  let output: unknown;
  if (row.attempt_output_ref !== null) {
    let stored;
    try {
      stored = parseStoredExecutionValueV1(row.attempt_output_ref);
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

export function completedInlineOutput(
  row: EventRow,
  controlOutputNodeIds: ReadonlySet<string>,
): readonly unknown[] {
  if (
    row.type !== 'node.succeeded' ||
    row.attempt_output_ref === null ||
    row.node_id === null ||
    !controlOutputNodeIds.has(row.node_id)
  )
    return [];
  const identity = attemptFact(row);
  let stored;
  try {
    stored = parseStoredExecutionValueV1(row.attempt_output_ref);
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
