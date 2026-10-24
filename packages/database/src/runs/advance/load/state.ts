import { sql } from 'drizzle-orm';
import { bindResourcePredicate } from '../../../tenant-access/resources/query-scope.js';
import { synchronizeHumanWait } from '../../pending-tasks/lifecycle/time-capacity.js';
import { readPendingTaskFacts } from '../../pending-tasks/lifecycle/facts.js';
import type { PoolClient } from 'pg';
import { workflowControlOutputNodeIds } from '@pertexo/workflow-model';

import {
  EXECUTION_SOURCE_SQL,
  parseExecutionSource,
} from '../../queries/execution/source.js';
import {
  CoordinatorRunStateCorruptError,
  type RunAdvanceState,
} from '../contract.js';
import {
  assertAvailableArtifacts,
  completedInlineOutput,
  mapEvent,
  maximumPersistedFacts,
  persistedFactCapacity,
  readPersistedFacts,
} from './facts.js';
import { pendingFailureObservations } from './pending-failures.js';
import { readCallFacts } from '../../calls/facts.js';
import { readRunCompletionValues } from './completion.js';

/** The locked run row the transition is saved against. */
export type CoordinatorCommitRow = Readonly<{
  revision: number;
  workflow_version_id: string;
  status: string;
  cancel_requested_at: Date | null;
  deadline_expired: boolean;
  workflow_id: string;
  trigger_type: string;
  started_at: Date | null;
  created_at: Date;
  failure_notification_destination_id: string | null;
  failure_notification_destination_config_version: number | null;
  failure_notification_side_effect_class: string | null;
  execution_entitlement_version: number;
  input_ref: unknown;
  variable_set_revision: number | null;
  human_wait_started_at: Date | null;
  has_unconsumed_tasks: boolean;
  has_human_child?: boolean;
  human_resume_deferred?: boolean;
}>;

export type PendingCoordinatorFailure = Readonly<{
  attempt_id: string;
  attempt_number: number;
  completed_at: Date;
  executor_error_kind: string;
  executor_failure_kind: string;
  executor_retry_after_millis: number | null;
  executor_possibly_dispatched: boolean;
  invocation_key: string;
  safe_error_code: string;
}>;

export type LoadedRunAdvance =
  | Readonly<{ kind: 'not_found' | 'capacity_exceeded' }>
  | Readonly<{
      kind: 'loaded';
      row: CoordinatorCommitRow;
      state: RunAdvanceState;
      pendingFailures: readonly PendingCoordinatorFailure[];
    }>;

type LockedRow = CoordinatorCommitRow &
  Readonly<{
    scheduler_state: unknown;
    next_event_sequence: number | null;
    checkpoint_deadline_expired: boolean | null;
    deadline_at: Date | null;
    version_id: string | null;
    version_workspace_id: string | null;
    version_workflow_id: string | null;
    version_number: number | null;
    checksum: string | null;
    executable_json: unknown;
    test_dispositions: unknown;
    test_expires_at: unknown;
  }>;

function publishedVersion(row: LockedRow): unknown {
  if (row.version_id === null) return undefined;
  return {
    checksum: row.checksum,
    executable_json: row.executable_json,
    test_dispositions: row.test_dispositions,
    test_expires_at: row.test_expires_at,
    id: row.version_id,
    version_number: row.version_number,
    workflow_id: row.version_workflow_id,
    workspace_id: row.version_workspace_id,
  };
}

/** Locks the run and reads everything the engine needs to advance it. */
export async function loadRunForAdvance(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
  }>,
): Promise<LoadedRunAdvance> {
  const { workspaceId, runId } = input;
  const locked = await lockRunForAdvance(client, workspaceId, runId);
  let row = locked.rows[0];
  if (row === undefined) return Object.freeze({ kind: 'not_found' });
  const taskOutcomes = row.has_unconsumed_tasks
    ? await readPendingTaskFacts(client, workspaceId, runId)
    : [];
  const calls = await readCallFacts(client, workspaceId, runId);
  row = { ...row, has_human_child: calls.hasHumanChild };
  const hasHumanWait =
    row.human_wait_started_at !== null ||
    row.has_unconsumed_tasks ||
    calls.hasHumanChild;
  if (hasHumanWait)
    row = {
      ...row,
      ...(await synchronizeHumanWait(client, workspaceId, {
        runId,
        phase: 'loading',
      })),
    };
  // A run's version is immutable; one that is gone went with its run.
  const version = parseExecutionSource(
    publishedVersion(row) as Record<string, unknown> | undefined,
  );
  if (version === null) return Object.freeze({ kind: 'not_found' });
  const firstSequence = row.next_event_sequence;
  if (firstSequence === null || firstSequence < 1)
    throw new CoordinatorRunStateCorruptError();

  // Facts appended after this point belong to the next advance delivery.
  const capacity = await persistedFactCapacity(
    client,
    workspaceId,
    runId,
    firstSequence,
  );
  if (capacity.count > maximumPersistedFacts)
    return Object.freeze({ kind: 'capacity_exceeded' });
  const facts = await readPersistedFacts(client, {
    count: capacity.count,
    firstSequence,
    lastSequence: capacity.lastSequence,
    maximumStorageBytes: capacity.maximumStorageBytes,
    runId,
    workspaceId,
  });
  for (const [index, fact] of facts.entries())
    if (fact.sequence !== firstSequence + index)
      throw new CoordinatorRunStateCorruptError();
  if (facts.length !== capacity.count)
    throw new CoordinatorRunStateCorruptError();

  const observations: unknown[] = facts.map(mapEvent);
  const pendingFailures = await readPendingFailures(client, workspaceId, runId);
  observations.push(...pendingFailureObservations(pendingFailures));
  await assertAvailableArtifacts(client, workspaceId, observations);
  const deadlineAt = row.deadline_at;
  const deadlineExpired =
    deadlineAt !== null &&
    row.deadline_expired &&
    !(row.checkpoint_deadline_expired ?? false);
  if (deadlineExpired)
    observations.push({
      kind: 'deadline_expired',
      occurredAt: deadlineAt.toISOString(),
    });
  // Only invocations already waiting in the stored checkpoint can come due;
  // a wait recorded by a new fact comes due on the next advance.
  const due = await client.query<{ invocation_key: string; due_at: Date }>(
    `select node.invocation_key,
            coalesce(node.retry_due_at, node.resume_at) as due_at
       from app.node_runs node
       where node.workspace_id = $1 and node.workflow_run_id = $2
         and node.status = 'waiting' and node.control_kind is distinct from 'human_task'
         and coalesce(node.retry_due_at, node.resume_at) <= clock_timestamp()
         and node.invocation_key in (
           select invocation->>'invocationKey'
             from jsonb_array_elements($3::jsonb->'invocations') invocation
            where invocation->>'status' = 'waiting')
       order by node.invocation_key`,
    [workspaceId, runId, JSON.stringify(row.scheduler_state)],
  );
  observations.push(
    ...due.rows.map((dueRow) => ({
      kind: 'due_at',
      invocationKey: dueRow.invocation_key,
      occurredAt: dueRow.due_at.toISOString(),
    })),
  );

  let controlOutputNodeIds: ReadonlySet<string>;
  try {
    controlOutputNodeIds = workflowControlOutputNodeIds(version.executableJson);
  } catch {
    throw new CoordinatorRunStateCorruptError();
  }
  return Object.freeze({
    kind: 'loaded',
    row,
    pendingFailures,
    state: Object.freeze({
      hasExecutionSlot:
        calls.hasExecutionSlot && row.human_wait_started_at === null,
      callOutcomes: calls.callOutcomes,
      taskOutcomes,
      runId,
      workflowVersionId: row.workflow_version_id,
      checkpoint: row.scheduler_state,
      observations: Object.freeze(observations),
      completedOutputs: Object.freeze(
        facts.flatMap((fact) =>
          completedInlineOutput(fact, controlOutputNodeIds),
        ),
      ),
      workflow: version,
      readCompletionValues: (nodeIds?: readonly string[]) =>
        readRunCompletionValues(client, {
          workspaceId,
          runId,
          inputRef: row.input_ref,
          variableSetRevision: row.variable_set_revision,
          nodeIds,
        }),
    }),
  });
}

async function readPendingFailures(
  client: PoolClient,
  workspaceId: string,
  runId: string,
): Promise<PendingCoordinatorFailure[]> {
  const pendingFailures = await client.query<PendingCoordinatorFailure>(
    `select attempt.id attempt_id, attempt.attempt_number,
            coalesce(attempt.completed_at, attempt.updated_at) completed_at,
            attempt.executor_failure_kind, attempt.executor_retry_after_millis,
            attempt.executor_error_kind, attempt.executor_possibly_dispatched,
            attempt.safe_error_code, node.invocation_key
       from app.node_attempts attempt
       join app.node_runs node
         on node.workspace_id = attempt.workspace_id
        and node.id = attempt.node_run_id
       where attempt.workspace_id = $1 and node.workflow_run_id = $2
         and node.current_attempt_id = attempt.id
         and node.current_attempt_number = attempt.attempt_number
         and node.status = 'running' and attempt.status = 'failed'
         and attempt.retry_decision = 'pending'
       order by node.invocation_key, attempt.id
       for update of node, attempt`,
    [workspaceId, runId],
  );
  return pendingFailures.rows;
}

async function lockRunForAdvance(
  client: PoolClient,
  workspaceId: string,
  runId: string,
) {
  const locked = await client.query<LockedRow>(
    `select checkpoint.revision, checkpoint.scheduler_state,
            checkpoint.workflow_version_id,
            (checkpoint.scheduler_state->>'nextEventSequence')::int
              as next_event_sequence,
            (checkpoint.scheduler_state->>'deadlineExpired')::boolean
              as checkpoint_deadline_expired,
            run.status, run.cancel_requested_at, run.workflow_id,
            run.trigger_type, run.started_at, run.created_at,
            run.failure_notification_destination_id,
            run.failure_notification_destination_config_version,
            run.failure_notification_side_effect_class,
            run.execution_entitlement_version, run.input_ref, run.variable_set_revision, run.deadline_at,run.human_wait_started_at,
            exists(select 1 from app.pending_run_tasks task where task.workspace_id=run.workspace_id and task.run_id=run.id and task.consumed_at is null) has_unconsumed_tasks,
            run.deadline_at is not null
              and run.deadline_at <= clock_timestamp() as deadline_expired,
            version.id as version_id, version.workspace_id as version_workspace_id,
            version.workflow_id as version_workflow_id, version.version_number,
            version.checksum, version.executable_json, version.test_dispositions, version.test_expires_at
       from app.workflow_runs run
       join app.run_checkpoints checkpoint
         on checkpoint.workspace_id = run.workspace_id
        and checkpoint.workflow_run_id = run.id
        and checkpoint.workflow_version_id = run.workflow_version_id
       left join ${bindResourcePredicate(sql`${EXECUTION_SOURCE_SQL}`, [])}
         on version.workspace_id = run.workspace_id
        and version.id = run.workflow_version_id
       where run.workspace_id = $1 and run.id = $2
       for no key update of run, checkpoint`,
    [workspaceId, runId],
  );

  return locked;
}
