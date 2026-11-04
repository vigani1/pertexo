import { isStoredDataError } from '../../../shared/stored-values.js';
import { reacquireSlotAfterTimedWait } from '../timed-wait-slot.repository.js';
import {
  lockRunForAdvance,
  readPendingFailures,
  readDueInvocations,
} from './locks.repository.js';
import { synchronizeHumanWait } from '../../pending-tasks/lifecycle/time-capacity.repository.js';
import { readPendingTaskFacts } from '../../pending-tasks/lifecycle/facts.repository.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { workflowControlOutputNodeIds } from '@pertexo/workflow-model';

import { projectExecutionSource } from '../../queries/execution/source.repository.js';
import { CoordinatorRunStateCorruptError } from '../../state-errors.js';
import type { RunAdvanceState } from '../run-advance.types.js';
import {
  assertAvailableArtifacts,
  completedInlineOutput,
  mapEvent,
} from './event-facts.repository.js';
import {
  maximumPersistedFacts,
  persistedFactCapacity,
  readPersistedFacts,
} from './facts.repository.js';
import { pendingFailureObservations } from './pending-failures.js';
import { readCallFacts } from '../../calls/facts.repository.js';
import { readRunCompletionValues } from './completion.repository.js';

type LockedCoordinatorRow = Awaited<
  ReturnType<typeof lockRunForAdvance>
>[number]['run'];
export type CoordinatorCommitRow = Omit<
  LockedCoordinatorRow,
  'scheduler_state' | 'deadline_at'
> &
  Readonly<{ has_human_child?: boolean; human_resume_deferred?: boolean }>;
export type PendingCoordinatorFailure = Awaited<
  ReturnType<typeof readPendingFailures>
>[number];

export type LoadedRunAdvance =
  | Readonly<{ kind: 'not_found' | 'capacity_exceeded' }>
  | Readonly<{
      kind: 'loaded';
      row: CoordinatorCommitRow;
      state: RunAdvanceState;
      pendingFailures: readonly PendingCoordinatorFailure[];
    }>;

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
  const selected = locked[0];
  if (selected === undefined) return Object.freeze({ kind: 'not_found' });
  try {
    return await loadLockedRunState(client, input, selected);
  } catch (error: unknown) {
    if (
      error instanceof CoordinatorRunStateCorruptError ||
      isStoredDataError(error)
    )
      throw new CoordinatorRunStateCorruptError(selected.run.revision, {
        cause: error,
      });
    throw error;
  }
}

async function loadLockedRunState(
  client: PoolClient,
  { workspaceId, runId }: Readonly<{ workspaceId: string; runId: string }>,
  selected: Awaited<ReturnType<typeof lockRunForAdvance>>[number],
): Promise<LoadedRunAdvance> {
  let row: LockedCoordinatorRow & CoordinatorCommitRow = selected.run;
  const stored = coordinatorCheckpointFieldsSchema.safeParse(
    row.scheduler_state,
  );
  if (!stored.success) throw new CoordinatorRunStateCorruptError();
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
  row = await reacquireSlotAfterTimedWait(client, { workspaceId, runId }, row);
  // A run's version is immutable; one that is gone went with its run.
  const version = projectExecutionSource(selected.version ?? undefined);
  if (version === null) return Object.freeze({ kind: 'not_found' });
  const firstSequence = stored.data.nextEventSequence;

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
    !(stored.data.deadlineExpired ?? false);
  if (deadlineExpired)
    observations.push({
      kind: 'deadline_expired',
      occurredAt: deadlineAt.toISOString(),
    });
  // Only invocations already waiting in the stored checkpoint can come due;
  // a wait recorded by a new fact comes due on the next advance.
  const waitingKeys = stored.data.invocations.flatMap(
    ({ invocationKey, status }) =>
      status === 'waiting' ? [invocationKey] : [],
  );
  const due =
    waitingKeys.length === 0
      ? []
      : await readDueInvocations(client, { workspaceId, runId, waitingKeys });
  observations.push(
    ...due.map((dueRow) => ({
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
      hasExecutionSlot: holdsExecutionSlot(row, calls.hasExecutionSlot),
      callOutcomes: calls.callOutcomes,
      taskOutcomes,
      runId,
      workflowVersionId: row.workflow_version_id,
      occurredAt: capacity.observedAt.toISOString(),
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

// The loader owns these fields; the engine parses the full scheduler afterwards.
const coordinatorCheckpointFieldsSchema = z.object({
  nextEventSequence: z.number().int().positive().max(2_147_483_647),
  deadlineExpired: z.boolean().optional(),
  invocations: z.array(
    z.object({ invocationKey: z.string(), status: z.string() }),
  ),
});

/** A run parked on a person or a timer has given its slot back, and so has a parent lending it. */
function holdsExecutionSlot(
  row: Pick<
    LockedCoordinatorRow,
    'human_wait_started_at' | 'timed_wait_started_at'
  >,
  slotNotLent: boolean,
): boolean {
  return (
    slotNotLent &&
    row.human_wait_started_at === null &&
    row.timed_wait_started_at === null
  );
}
