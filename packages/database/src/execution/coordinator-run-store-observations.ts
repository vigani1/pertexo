import type { Pool, PoolClient } from 'pg';
import { WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1 } from '@pertexo/workflow-model/observation-window';

import {
  CoordinatorRunStateCorruptError,
  coordinatorIdentitySchema,
  type LoadAdvanceStateInput,
  type LoadAdvanceStateResult,
} from './coordinator-run-store-contract.js';
import {
  assertCoordinatorNotAborted,
  withCoordinatorReadClient,
} from './coordinator-run-store-transactions.js';
import { validateLoadedCheckpointPhysicalState } from './coordinator-run-store-physical-state.js';
import {
  parsePersistedWorkflowCheckpoint,
  type PersistedWorkflowCheckpoint,
} from '../compatibility/persisted-workflow-checkpoint.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from './stored-execution-value.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumCanonicalEventPayloadBytes =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.canonicalFactBytes;
export const maximumPersistedFacts =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.facts;
const maximumCanonicalPersistedFactBytes =
  WORKFLOW_OBSERVATION_WINDOW_LIMITS_V1.canonicalWindowBytes;
const maximumPersistedFactRowsPerFetch = 64;

export function normalizedJson(value: unknown): unknown {
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
): Promise<Readonly<{ count: number; storageBytes: number }>> {
  const result = await client.query<{
    fact_count: number;
    storage_bytes: string;
  }>(
    `select count(*)::int as fact_count,
            coalesce(sum(octet_length(payload::text)),0)::bigint as storage_bytes
     from app.run_events
     where workspace_id=$1 and workflow_run_id=$2 and sequence >= $3
       and ($4::int is null or sequence <= $4::int)`,
    [workspaceId, runId, firstSequence, lastSequence ?? null],
  );
  const row = result.rows[0];
  const count = row?.fact_count;
  const storageBytes = Number(row?.storage_bytes);
  if (
    count === undefined ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(storageBytes) ||
    count < 0 ||
    storageBytes < 0
  )
    throw new CoordinatorRunStateCorruptError();
  return Object.freeze({ count, storageBytes });
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

type EventRow = Readonly<{
  sequence: number;
  type: string;
  payload: unknown;
  created_at: Date;
  attempt_id: string | null;
  attempt_number: number | null;
  attempt_status: string | null;
  attempt_output_ref: unknown;
  executor_failure_kind: string | null;
  node_output_ref: unknown;
  invocation_key: string | null;
  node_run_id: string | null;
  current_attempt_id: string | null;
  node_status: string | null;
  resume_at: Date | null;
  retry_due_at: Date | null;
  retry_decision: string | null;
  wait_kind: 'node_wait' | 'retry_backoff' | null;
}>;

export async function readPersistedFacts(
  client: PoolClient,
  input: Readonly<{
    count: number;
    firstSequence: number;
    lastSequence?: number;
    runId: string;
    workspaceId: string;
  }>,
): Promise<readonly EventRow[]> {
  const facts: EventRow[] = [];
  let canonicalBytes = 0;
  let nextSequence = input.firstSequence;
  while (facts.length < input.count) {
    const result = await client.query<EventRow>(
      `select event.sequence, event.type, event.payload, event.created_at,
              attempt.id as attempt_id, attempt.attempt_number,
              attempt.status as attempt_status,
              attempt.output_ref as attempt_output_ref,
              attempt.executor_failure_kind,attempt.retry_decision,
              node.id as node_run_id, node.invocation_key,
              node.current_attempt_id, node.status as node_status,
              node.output_ref as node_output_ref,
               node.resume_at, node.retry_due_at, node.wait_kind
       from app.run_events event
       left join app.node_attempts attempt
         on attempt.workspace_id=event.workspace_id
        and attempt.id::text=event.payload->>'attemptId'
       left join app.node_runs node
         on node.workspace_id=event.workspace_id
        and node.id::text=event.payload->>'nodeRunId'
        and attempt.node_run_id=node.id
        and node.workflow_run_id=event.workflow_run_id
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
        maximumPersistedFactRowsPerFetch,
      ],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const canonical = canonicalEventPayload(row.payload);
      canonicalBytes += canonical.bytes;
      if (canonicalBytes > maximumCanonicalPersistedFactBytes)
        throw new CoordinatorRunStateCorruptError();
      facts.push(Object.freeze({ ...row, payload: canonical.payload }));
      nextSequence = row.sequence + 1;
    }
  }
  return Object.freeze(facts);
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
    const requiredLaterType =
      row.node_status === 'waiting'
        ? row.attempt_status === 'succeeded'
          ? 'node.waiting'
          : row.attempt_status === 'failed'
            ? 'node.retry_scheduled'
            : undefined
        : row.attempt_status === row.node_status && row.node_status !== null
          ? `node.${row.node_status}`
          : undefined;
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

function completedInlineOutput(row: EventRow): readonly unknown[] {
  if (row.type !== 'node.succeeded' || row.attempt_output_ref === null)
    return [];
  const identity = attemptFact(row);
  let stored;
  try {
    stored = parseStoredExecutionValueV1(row.attempt_output_ref);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  const value = stored.kind === 'inline' ? stored.value : undefined;
  const isRecord =
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const outputRecord = isRecord
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
  const isForEachOutput =
    outputRecord !== undefined &&
    Object.keys(outputRecord).length === 2 &&
    Array.isArray(outputRecord.items) &&
    outputRecord.items.length <= 1_000 &&
    Number.isSafeInteger(outputRecord.iterationCount) &&
    outputRecord.iterationCount === outputRecord.items.length;
  return stored.kind === 'inline' &&
    isRecord &&
    (Object.hasOwn(outputRecord ?? {}, 'selectedPort') || isForEachOutput)
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

function freshSemanticFacts(
  observations: readonly unknown[],
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const facts = new Map<string, Readonly<Record<string, unknown>>>();
  for (const observation of observations) {
    const value = record(observation);
    if (
      (value.kind === 'wait' ||
        value.kind === 'outcome' ||
        value.kind === 'attempt_failure') &&
      typeof value.invocationKey === 'string'
    ) {
      facts.set(value.invocationKey, value);
    }
  }
  return facts;
}

export async function loadCoordinatorAdvanceState(
  pool: Pool,
  input: LoadAdvanceStateInput,
): Promise<LoadAdvanceStateResult> {
  assertCoordinatorNotAborted(input.signal);
  const workspaceId = coordinatorIdentitySchema.parse(input.workspaceId);
  const runId = coordinatorIdentitySchema.parse(input.runId);
  return withCoordinatorReadClient(
    pool,
    workspaceId,
    input.signal,
    async (client) => {
      const result = await client.query<{
        run_id: string;
        workflow_version_id: string;
        status: string;
        cancel_requested_at: Date | null;
        deadline_at: Date | null;
        database_now: Date;
        revision: number;
        engine_version: string;
        scheduler_state: unknown;
        executable_schema_version: number | null;
        event_high_water: number;
      }>(
        `select run.id as run_id, run.workflow_version_id, run.status,
                    run.cancel_requested_at, run.deadline_at,
                    clock_timestamp() as database_now,
                    checkpoint.revision, checkpoint.engine_version,
                    checkpoint.scheduler_state,
                    version.executable_schema_version,
                    coalesce((select max(event.sequence) from app.run_events event
                              where event.workspace_id = run.workspace_id
                                and event.workflow_run_id = run.id), 0)::int as event_high_water
             from app.workflow_runs run
             join app.run_checkpoints checkpoint
               on checkpoint.workspace_id = run.workspace_id
              and checkpoint.workflow_run_id = run.id
              and checkpoint.workflow_version_id = run.workflow_version_id
             left join app.workflow_versions version
               on version.workspace_id = run.workspace_id
              and version.id = run.workflow_version_id
             where run.workspace_id = $1 and run.id = $2`,
        [workspaceId, runId],
      );
      assertCoordinatorNotAborted(input.signal);
      const row = result.rows[0];
      if (row === undefined) return Object.freeze({ kind: 'not_found' });
      if (row.executable_schema_version !== 2)
        return Object.freeze({ kind: 'not_executable' });
      let checkpoint: PersistedWorkflowCheckpoint;
      try {
        checkpoint = parsePersistedWorkflowCheckpoint(row.scheduler_state);
      } catch {
        return Object.freeze({ kind: 'unsupported_checkpoint' });
      }
      if (
        checkpoint.revision !== row.revision ||
        checkpoint.engineVersion !== row.engine_version ||
        checkpoint.workflowVersionId !== row.workflow_version_id ||
        checkpoint.runStatus !== row.status
      )
        throw new CoordinatorRunStateCorruptError();

      const factCapacity = await persistedFactCapacity(
        client,
        workspaceId,
        runId,
        checkpoint.nextEventSequence,
      );
      if (factCapacity.count > maximumPersistedFacts)
        return Object.freeze({ kind: 'capacity_exceeded' });
      const events = await readPersistedFacts(client, {
        count: factCapacity.count,
        firstSequence: checkpoint.nextEventSequence,
        runId,
        workspaceId,
      });
      if (events.length !== factCapacity.count)
        throw new CoordinatorRunStateCorruptError();
      for (const [index, event] of events.entries()) {
        if (event.sequence !== checkpoint.nextEventSequence + index)
          throw new CoordinatorRunStateCorruptError();
      }
      const observedHighWater =
        checkpoint.nextEventSequence + events.length - 1;
      if (observedHighWater !== row.event_high_water)
        throw new CoordinatorRunStateCorruptError();
      validatePersistedFactBatch(events);
      const observations = events.map(mapEvent);
      const completedOutputs = events.flatMap(completedInlineOutput);
      const pendingFailures = await client.query<{
        attempt_id: string;
        attempt_number: number;
        completed_at: Date;
        executor_error_kind: string;
        executor_failure_kind: string;
        executor_possibly_dispatched: boolean;
        invocation_key: string;
        safe_error_code: string;
      }>(
        `select attempt.id attempt_id,attempt.attempt_number,
                    attempt.completed_at,attempt.executor_failure_kind,
                    attempt.executor_error_kind,
                    attempt.executor_possibly_dispatched,
                    attempt.safe_error_code,node.invocation_key
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id
              and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and node.workflow_run_id=$2
               and node.current_attempt_id=attempt.id
               and node.current_attempt_number=attempt.attempt_number
               and node.status='running' and attempt.status='failed'
               and attempt.retry_decision='pending'
             order by node.invocation_key,attempt.id`,
        [workspaceId, runId],
      );
      for (const failure of pendingFailures.rows) {
        if (
          !['failed', 'canceled', 'retry', 'outcome_unknown'].includes(
            failure.executor_failure_kind,
          ) ||
          ![
            'authentication',
            'canceled',
            'configuration',
            'internal',
            'network',
            'provider',
            'rate_limit',
            'timeout',
          ].includes(failure.executor_error_kind)
        )
          throw new CoordinatorRunStateCorruptError();
        observations.push({
          kind: 'attempt_failure',
          occurredAt: failure.completed_at.toISOString(),
          invocationKey: failure.invocation_key,
          attemptId: failure.attempt_id,
          attemptNumber: failure.attempt_number,
          failureKind: failure.executor_failure_kind,
          errorKind: failure.executor_error_kind,
          possiblyDispatched: failure.executor_possibly_dispatched,
          safeErrorCode: failure.safe_error_code,
        });
      }
      const checkpointInvocations = new Map(
        checkpoint.invocations.map((invocation) => [
          invocation.invocationKey,
          invocation,
        ]),
      );
      for (const observation of observations) {
        const value = record(observation);
        if (value.kind === 'cancel_requested') continue;
        if (
          typeof value.invocationKey !== 'string' ||
          typeof value.attemptNumber !== 'number'
        )
          throw new CoordinatorRunStateCorruptError();
        const invocation = checkpointInvocations.get(value.invocationKey);
        if (
          invocation?.status !== 'running' ||
          invocation.attemptNumber !== value.attemptNumber
        )
          throw new CoordinatorRunStateCorruptError();
      }
      await validateLoadedCheckpointPhysicalState(
        client,
        workspaceId,
        runId,
        checkpoint,
        freshSemanticFacts(observations),
      );
      const hasFreshCancellation = observations.some(
        (observation) => record(observation).kind === 'cancel_requested',
      );
      if (
        (checkpoint.cancelRequested && row.cancel_requested_at === null) ||
        (hasFreshCancellation && row.cancel_requested_at === null) ||
        (checkpoint.deadlineExpired &&
          (row.deadline_at === null || row.deadline_at > row.database_now))
      )
        throw new CoordinatorRunStateCorruptError();
      const artifactIds = observations.flatMap((observation) => {
        const value = record(observation);
        const output = value.output;
        if (output === undefined) return [];
        const parsedOutput = record(output);
        return parsedOutput.kind === 'artifact' &&
          typeof parsedOutput.artifactId === 'string'
          ? [parsedOutput.artifactId]
          : [];
      });
      if (artifactIds.length > 0) {
        const availableArtifacts = await client.query<{ id: string }>(
          `select id from app.artifacts
               where workspace_id = $1 and id = any($2::uuid[])
                  and status = 'available' and deleted_at is null
                for share`,
          [workspaceId, artifactIds],
        );
        if (
          new Set(availableArtifacts.rows.map(({ id }) => id)).size !==
          new Set(artifactIds).size
        )
          throw new CoordinatorRunStateCorruptError();
      }
      if (
        row.cancel_requested_at !== null &&
        !checkpoint.cancelRequested &&
        !hasFreshCancellation
      )
        throw new CoordinatorRunStateCorruptError();
      if (
        row.deadline_at !== null &&
        row.deadline_at <= row.database_now &&
        !checkpoint.deadlineExpired
      )
        observations.push({
          kind: 'deadline_expired',
          occurredAt: row.deadline_at.toISOString(),
        });

      const due = await client.query<{
        invocation_key: string;
        due_at: Date;
      }>(
        `select invocation_key, coalesce(retry_due_at, resume_at) as due_at
             from app.node_runs
             where workspace_id = $1 and workflow_run_id = $2
               and status = 'waiting'
               and coalesce(retry_due_at, resume_at) <= $3
               and invocation_key = any($4::varchar[])
             order by invocation_key
             limit 10001`,
        [
          workspaceId,
          runId,
          row.database_now,
          checkpoint.invocations
            .filter(({ status }) => status === 'waiting')
            .map(({ invocationKey }) => invocationKey),
        ],
      );
      if (due.rows.length > 10_000) throw new CoordinatorRunStateCorruptError();
      observations.push(
        ...due.rows.map(({ invocation_key: invocationKey, due_at: dueAt }) => {
          const invocation = checkpointInvocations.get(invocationKey);
          if (
            invocation?.status !== 'waiting' ||
            invocation.resumeAt !== dueAt.toISOString()
          )
            throw new CoordinatorRunStateCorruptError();
          return {
            kind: 'due_at',
            invocationKey,
            occurredAt: dueAt.toISOString(),
          };
        }),
      );
      assertCoordinatorNotAborted(input.signal);
      return Object.freeze({
        kind: 'ready',
        state: Object.freeze({
          runId: row.run_id,
          workflowVersionId: row.workflow_version_id,
          checkpoint,
          observations: Object.freeze(observations.map(Object.freeze)),
          completedOutputs: Object.freeze(completedOutputs.map(Object.freeze)),
        }),
      });
    },
  );
}
