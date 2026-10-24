import { triggerCoordinatedEvents as events } from '../../schema/event-coordination/records.js';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { and, eq, sql } from 'drizzle-orm';
import {
  decideEventCoordination,
  EVENT_COORDINATION_LIMITS,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { WorkflowAlreadyRunningError } from '../../runs/commands/concurrency.queries.js';
import { recordWorkflowTriggerSkip } from '../skips.repository.js';
import {
  recordCoordinatedEvent,
  finishCoordinatedEvent,
  coordinatedReceipt,
} from './events.repository.js';
import {
  eventDatabaseTime,
  loadEventWindow,
  chargeEventWindow,
} from './keys.repository.js';
import type {
  CoordinateEventInput,
  CoordinateEventResult,
  StartCoordinatedRun,
} from './contract.js';

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
  const now = await eventDatabaseTime(transaction);
  const key = await loadEventWindow(transaction, input, now);
  if (key === undefined) return refuse('coordination_full');
  const pending = (
    await transaction.db
      .select({
        id: events.id,
        input_bytes: events.inputBytes,
        deadline_at: events.deadlineAt,
      })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, transaction.workspaceId),
          eq(events.keyId, key.id),
          eq(events.status, 'pending'),
        ),
      )
      .orderBy(events.receivedAt, events.id)
      .limit(1)
      .for('update')
  )[0];
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
  const budget = (
    await transaction.db
      .select({
        count: sql<number>`count(*)::integer`,
        bytes: sql<number>`coalesce(sum(${events.inputBytes}),0)::integer`,
      })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, transaction.workspaceId),
          eq(events.status, 'pending'),
        ),
      )
  )[0];
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
  await transaction.db.execute(sql`savepoint coordinated_run_admission`);
  try {
    const accepted = await start(transaction, input.eventId);
    await transaction.db.execute(
      sql`release savepoint coordinated_run_admission`,
    );
    await chargeEventWindow(transaction, keyId, policy, decision.window);
    await recordCoordinatedEvent(transaction, input, {
      outcome: 'accepted',
      status: 'started',
      runId: accepted.runId,
    });
    return { runId: accepted.runId, replayed: accepted.duplicate };
  } catch (error) {
    if (!(error instanceof WorkflowAlreadyRunningError)) throw error;
    await transaction.db.execute(
      sql`rollback to savepoint coordinated_run_admission`,
    );
    await transaction.db.execute(
      sql`release savepoint coordinated_run_admission`,
    );
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
}
function pendingEventQuotaExceeded(
  budget: Readonly<{ count: number; bytes: number }> | undefined,
  replaced: Readonly<{ input_bytes: number }> | undefined,
  bytes: number,
): boolean {
  return (
    (budget?.count ?? 0) + (replaced === undefined ? 1 : 0) >
      EVENT_COORDINATION_LIMITS.pendingEvents ||
    (budget?.bytes ?? 0) - (replaced?.input_bytes ?? 0) + bytes >
      EVENT_COORDINATION_LIMITS.pendingBytes
  );
}
