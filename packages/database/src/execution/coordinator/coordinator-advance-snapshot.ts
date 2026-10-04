import type { PoolClient } from 'pg';
import { workflowCallableDeclarationSchemaV1 } from '@pertexo/workflow-model/callable-graph-contract';
import {
  workflowControlOutputNodeIdsV2,
  workflowControlOutputNodeIdsV3,
  workflowCallNodeIdsV3,
} from '@pertexo/workflow-model/graph';
import {
  CoordinatorRunStateCorruptError,
  coordinatorDeliverySchema,
  type LoadAdvanceStateResult,
  type CoordinatorAdvanceDelivery,
} from './coordinator-run-store-contract.js';
import { assertCoordinatorNotAborted } from './coordinator-run-store-transactions.js';
import {
  assertAvailableArtifacts,
  validateLoadedCheckpointPhysicalState,
} from './coordinator-run-store-physical-state.js';
import {
  parseCoordinatorCheckpoint,
  coordinatorExecutableFormat,
  type CoordinatorCheckpoint as PersistedWorkflowCheckpoint,
} from './coordinator-checkpoint.js';
import { loadPendingFailureObservations } from './coordinator-pending-failure-observations.js';
import { loadCoordinatorCallMaterials } from './coordinator-call-materials.js';
import { parseNativeCoordinatorInspection } from './coordinator-native-value-reads.js';
import type { CoordinatorExecutableCapability } from './coordinator-executable-capability.js';
import {
  completedInlineOutput,
  mapEvent,
  maximumPersistedFacts,
  persistedFactCapacity,
  readPersistedFacts,
  record,
  validatePersistedFactBatch,
} from './coordinator-run-store-observation-facts.js';
export type NativeObservationAdapter = Readonly<{
  controlReadTimeoutMillis: number;
  capability: CoordinatorExecutableCapability;
}>;

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

type CoordinatorObservation = ReturnType<typeof mapEvent>;
type CheckpointInvocation = PersistedWorkflowCheckpoint['invocations'][number];
function assertObservationInvocationBindings(
  checkpoint: PersistedWorkflowCheckpoint,
  observations: readonly CoordinatorObservation[],
): Map<string, CheckpointInvocation> {
  const checkpointInvocations = new Map<string, CheckpointInvocation>();
  for (const invocation of checkpoint.invocations)
    checkpointInvocations.set(invocation.invocationKey, invocation);
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
  return checkpointInvocations;
}
function assertPersistedControlState(
  checkpoint: PersistedWorkflowCheckpoint,
  observations: readonly CoordinatorObservation[],
  row: Readonly<{
    cancel_requested_at: Date | null;
    deadline_at: Date | null;
    database_now: Date;
  }>,
): boolean {
  let hasFreshCancellation = false;
  for (const observation of observations)
    if (record(observation).kind === 'cancel_requested') {
      hasFreshCancellation = true;
      break;
    }
  const cancellationEvidenceIsConsistent =
    (!checkpoint.cancelRequested && !hasFreshCancellation) ||
    row.cancel_requested_at !== null;
  if (!cancellationEvidenceIsConsistent)
    throw new CoordinatorRunStateCorruptError();
  if (
    checkpoint.deadlineExpired &&
    (row.deadline_at === null || row.deadline_at > row.database_now)
  )
    throw new CoordinatorRunStateCorruptError();
  return hasFreshCancellation;
}
interface CoordinatorAdvanceSnapshot {
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
  graph_schema_version: number;
  executable_checksum: string;
  executable_json: unknown;
  event_high_water: number;
}

async function readCoordinatorAdvanceSnapshot(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<CoordinatorAdvanceSnapshot | undefined> {
  const result = await client.query<CoordinatorAdvanceSnapshot>(
    `select run.id as run_id, run.workflow_version_id, run.status,
                run.cancel_requested_at, run.deadline_at,
                clock_timestamp() as database_now,
                checkpoint.revision, checkpoint.engine_version,
                checkpoint.scheduler_state,
                version.executable_schema_version,version.executable_json,
                version.schema_version as graph_schema_version,version.checksum as executable_checksum,
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
  return result.rows[0];
}

async function readDueCoordinatorObservations(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  databaseNow: Date,
  checkpoint: PersistedWorkflowCheckpoint,
  checkpointInvocations: ReadonlyMap<string, CheckpointInvocation>,
): Promise<readonly unknown[]> {
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
      databaseNow,
      checkpoint.invocations
        .filter(({ status }) => status === 'waiting')
        .map(({ invocationKey }) => invocationKey),
    ],
  );
  if (due.rows.length > 10_000) throw new CoordinatorRunStateCorruptError();
  return due.rows.map(({ invocation_key: invocationKey, due_at: dueAt }) => {
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
  });
}

async function validateNativeObservationOwner(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  row: CoordinatorAdvanceSnapshot,
  delivery: CoordinatorAdvanceDelivery | undefined,
  nativeAdapter: NativeObservationAdapter | undefined,
): Promise<boolean> {
  if (delivery === undefined) throw new CoordinatorRunStateCorruptError();
  const envelope = record(row.executable_json);
  if (
    !nativeAdapter?.capability.nativeReleases.some(
      (release) =>
        release.epoch === envelope.compatibilityReleaseEpoch &&
        release.fingerprint === envelope.compatibilityReleaseFingerprint,
    )
  )
    return false;
  const inspected = await client.query<{ result: unknown }>(
    'select app.inspect_native_coordinator_value_owner($1::jsonb) as result',
    [
      JSON.stringify({
        workspaceId,
        runId,
        workflowVersionId: row.workflow_version_id,
        expectedRevision: row.revision,
        delivery,
      }),
    ],
  );
  if (inspected.rows.length !== 1) throw new CoordinatorRunStateCorruptError();
  const inspection = parseNativeCoordinatorInspection(
    inspected.rows[0]?.result,
  );
  if (
    inspection.kind === 'stopped' &&
    !(
      (inspection.stop.kind === 'canceled' &&
        row.cancel_requested_at !== null) ||
      (inspection.stop.kind === 'timed_out' &&
        row.deadline_at !== null &&
        row.deadline_at <= row.database_now)
    )
  )
    throw new Error('Native coordinator observation owner is unavailable');
  return true;
}

/** Assemble observations only after an independent actual format/consumer recheck. */
export async function loadCoordinatorAdvanceSnapshot(
  client: PoolClient,
  {
    workspaceId,
    runId,
    signal,
    classifiedFormat,
    delivery,
    nativeAdapter,
  }: Readonly<{
    workspaceId: string;
    runId: string;
    signal: AbortSignal;
    classifiedFormat: NonNullable<
      ReturnType<typeof coordinatorExecutableFormat>
    >;
    delivery: CoordinatorAdvanceDelivery | undefined;
    nativeAdapter: NativeObservationAdapter | undefined;
  }>,
): Promise<LoadAdvanceStateResult> {
  const row = await readCoordinatorAdvanceSnapshot(client, workspaceId, runId);
  assertCoordinatorNotAborted(signal);
  if (row === undefined) return Object.freeze({ kind: 'not_found' });
  const executableFormat = coordinatorExecutableFormat(row);
  // Revalidate actual owner/format in this independent snapshot. The first
  // snapshot grants no payload authority or fallback when the format changes.
  if (executableFormat === undefined || executableFormat !== classifiedFormat)
    return Object.freeze({ kind: 'not_executable' });
  if (
    executableFormat === 3 &&
    !(await validateNativeObservationOwner(
      client,
      workspaceId,
      runId,
      row,
      delivery,
      nativeAdapter,
    ))
  )
    return Object.freeze({ kind: 'not_executable' });
  let checkpoint: PersistedWorkflowCheckpoint;
  try {
    checkpoint = parseCoordinatorCheckpoint(
      row.scheduler_state,
      executableFormat,
    );
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
    maximumStorageBytes: factCapacity.maximumStorageBytes,
    runId,
    workspaceId,
  });
  if (events.length !== factCapacity.count)
    throw new CoordinatorRunStateCorruptError();
  for (const [index, event] of events.entries()) {
    if (event.sequence !== checkpoint.nextEventSequence + index)
      throw new CoordinatorRunStateCorruptError();
  }
  const observedHighWater = checkpoint.nextEventSequence + events.length - 1;
  if (observedHighWater !== row.event_high_water)
    throw new CoordinatorRunStateCorruptError();
  validatePersistedFactBatch(events);
  const observations = events.map(mapEvent);
  let controlOutputNodeIds: ReadonlySet<string>;
  try {
    controlOutputNodeIds = (
      checkpoint.schemaVersion === 3
        ? workflowControlOutputNodeIdsV3
        : workflowControlOutputNodeIdsV2
    )(row.executable_json);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  const completedOutputs = events.flatMap((event) =>
    completedInlineOutput(event, controlOutputNodeIds),
  );
  const workflowCalls = await loadCoordinatorCallMaterials(client, {
    workspaceId,
    runId,
    checkpoint,
    events,
    ...(checkpoint.schemaVersion === 3
      ? {
          callNodeIds: workflowCallNodeIdsV3(row.executable_json),
          consumer: {
            workspaceId,
            runId,
            workflowVersionId: row.workflow_version_id,
            expectedRevision: checkpoint.revision,
            delivery: coordinatorDeliverySchema.parse(delivery),
          },
          loadDeclarations:
            row.cancel_requested_at === null &&
            (row.deadline_at === null || row.deadline_at > row.database_now),
        }
      : {}),
  });
  await loadPendingFailureObservations(
    client,
    workspaceId,
    runId,
    observations,
  );
  const checkpointInvocations = assertObservationInvocationBindings(
    checkpoint,
    observations,
  );
  await validateLoadedCheckpointPhysicalState(
    client,
    workspaceId,
    runId,
    checkpoint,
    freshSemanticFacts(observations),
    row.executable_json,
  );
  const hasFreshCancellation = assertPersistedControlState(
    checkpoint,
    observations,
    row,
  );
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
  await assertAvailableArtifacts(client, workspaceId, new Set(artifactIds));
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

  observations.push(
    ...(await readDueCoordinatorObservations(
      client,
      workspaceId,
      runId,
      row.database_now,
      checkpoint,
      checkpointInvocations,
    )),
  );
  assertCoordinatorNotAborted(signal);
  // Preserve declaration validation, but successful callable value material
  // belongs only to the later engine demand scope, not this SQL snapshot.
  if (checkpoint.schemaVersion === 3) {
    const executable = row.executable_json as object;
    const graph = Reflect.get(executable, 'graph') as object;
    const callable = Reflect.get(graph, 'callable') as unknown;
    if (callable !== undefined)
      workflowCallableDeclarationSchemaV1.parse(callable);
  }
  return Object.freeze({
    kind: 'ready',
    state: Object.freeze({
      runId: row.run_id,
      workflowVersionId: row.workflow_version_id,
      checkpoint,
      observations: Object.freeze(observations.map(Object.freeze)),
      completedOutputs: Object.freeze(completedOutputs.map(Object.freeze)),
      ...(workflowCalls === undefined ? {} : { workflowCalls }),
    }),
  });
}
