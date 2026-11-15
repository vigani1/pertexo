import { utf8ByteLength } from '@pertexo/workflow-model';
import {
  decideEventCoordination,
  EVENT_COORDINATION_LIMITS,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { WorkflowAlreadyRunningError } from '../../runs/commands/acceptance/run-admission.errors.js';
import { recordWorkflowTriggerSkip } from '../skips.repository.js';
import {
  recordCoordinatedEvent,
  finishCoordinatedEvent,
  coordinatedReceipt,
} from './events.repository.js';
import { loadEventWindow, chargeEventWindow } from './keys.repository.js';
import type {
  CoordinateEventInput,
  CoordinateEventResult,
  StartCoordinatedRun,
} from './event-coordination.types.js';
import { readDatabaseClock } from '../../shared/database-clock.repository.js';
import { admitInSavepoint } from '../admission-savepoint.repository.js';
import {
  lockOldestPendingEvent,
  readPendingEventBudget,
} from './pending.repository.js';
import { pendingEventQuotaExceeded } from './pending-quota.js';

/** Both ingress paths already hold the workspace admission lock and current publication fence. */
export async function coordinateEvent(
  transaction: WorkspaceTransaction,
  input: CoordinateEventInput,
  start: StartCoordinatedRun,
): Promise<CoordinateEventResult> {
  const refuse = async (reason: 'invalid_key' | 'coordination_full') => {
    await recordCoordinatedEvent(transaction, input, {
      outcome: 'refused',
      status: 'refused',
      reason,
    });
    return coordinatedReceipt(input.eventId, 'refused', 'refused', reason);
  };
  if (input.prepared.keyHash === null) return refuse('invalid_key');
  const now = await readDatabaseClock(transaction.db);
  const key = await loadEventWindow(transaction, input, now);
  if (key === undefined) return refuse('coordination_full');
  const pending = await lockOldestPendingEvent(transaction, key.id);
  const policy = input.prepared.policy;
  const decision = decideEventCoordination({
    policy,
    now: now.getTime(),
    window: {
      startedAt: key.window_started_at.getTime(),
      used: key.used_count,
    },
    hasPending: pending !== undefined,
  });
  if (decision.action === 'start')
    return startCoordinatedEvent(transaction, input, {
      keyId: key.id,
      decision,
      start,
    });
  if (decision.action === 'deduplicated' || decision.dueAt === undefined) {
    const reason =
      decision.action === 'deduplicated' ? 'duplicate_key' : 'throttle_limit';
    const outcome =
      decision.action === 'deduplicated' ? 'deduplicated' : 'throttled';
    await recordCoordinatedEvent(transaction, input, {
      outcome,
      status: 'skipped',
      reason,
    });
    return coordinatedReceipt(input.eventId, outcome, 'skipped', reason);
  }
  const bytes = utf8ByteLength(input.prepared.inputJson);
  const budget = await readPendingEventBudget(transaction);
  const replaced = policy.mode === 'debounce' ? pending : undefined;

  if (pendingEventQuotaExceeded(budget, replaced, bytes))
    return refuse('coordination_full');
  if (replaced !== undefined)
    await finishCoordinatedEvent(transaction, replaced.id, {
      status: 'coalesced',
      reason: 'newer_event',
    });
  const deadline =
    replaced?.deadline_at ??
    new Date(now.getTime() + EVENT_COORDINATION_LIMITS.pendingMillis);
  const outcome = decision.action === 'debounced' ? 'debounced' : 'throttled';
  await recordCoordinatedEvent(transaction, input, {
    outcome,
    status: 'pending',
    pending: {
      keyId: key.id,
      dueAt: new Date(Math.min(decision.dueAt, deadline.getTime())),
      deadlineAt: deadline,
    },
  });
  return coordinatedReceipt(input.eventId, outcome, 'pending');
}

async function startCoordinatedEvent(
  transaction: WorkspaceTransaction,
  input: CoordinateEventInput,
  {
    keyId,
    decision,
    start,
  }: Readonly<{
    keyId: string;
    decision: ReturnType<typeof decideEventCoordination>;
    start: StartCoordinatedRun;
  }>,
): Promise<CoordinateEventResult> {
  const policy = input.prepared.policy;
  const admission = await admitInSavepoint(
    transaction,
    'coordinated_run_admission',
    () => start(transaction, input.eventId),
    (error) => error instanceof WorkflowAlreadyRunningError,
  );
  if (!admission.admitted) {
    await recordWorkflowTriggerSkip(
      transaction,
      input.workflowId,
      input.source,
    );
    await recordCoordinatedEvent(transaction, input, {
      outcome: 'skipped',
      status: 'skipped',
      reason: 'concurrency_limit',
    });
    return { skipped: true, reason: 'concurrency_limit' };
  }
  const accepted = admission.value;
  await chargeEventWindow(transaction, keyId, policy, decision.window);
  await recordCoordinatedEvent(transaction, input, {
    outcome: 'accepted',
    status: 'started',
    runId: accepted.runId,
  });
  return { runId: accepted.runId, replayed: accepted.duplicate };
}
