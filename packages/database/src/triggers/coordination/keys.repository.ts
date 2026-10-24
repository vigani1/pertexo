import { alias } from 'drizzle-orm/pg-core';
import {
  triggerEventWindows as windows,
  triggerCoordinatedEvents as events,
} from '../../schema/event-coordination/records.js';
import { and, eq, exists, or, sql } from 'drizzle-orm';
import {
  EVENT_COORDINATION_LIMITS,
  type EventCoordinationPolicy,
  type EventCoordinationWindow,
} from '@pertexo/workflow-model';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { CoordinateEventInput } from './contract.js';
function readEventWindow(
  transaction: WorkspaceTransaction,
  input: CoordinateEventInput,
) {
  return transaction.db
    .select({
      id: windows.id,
      window_started_at: windows.windowStartedAt,
      used_count: windows.usedCount,
      expires_at: windows.expiresAt,
    })
    .from(windows)
    .where(
      and(
        eq(windows.workspaceId, transaction.workspaceId),
        eq(windows.workflowId, input.workflowId),
        eq(windows.nodeId, input.nodeId),
        eq(windows.policyHash, input.prepared.policyHash),
        eq(windows.keyHash, sql`${input.prepared.keyHash}`),
      ),
    )
    .for('update');
}
export type EventWindowRow = Awaited<
  ReturnType<typeof readEventWindow>
>[number];
export async function eventDatabaseTime(
  transaction: WorkspaceTransaction,
): Promise<Date> {
  const result = await transaction.db.execute<{ now: string }>(
    sql`select clock_timestamp() now`,
  );
  const at = result.rows[0]?.now;
  if (at === undefined) throw new Error('Event coordination clock unavailable');
  return new Date(at);
}
export async function loadEventWindow(
  transaction: WorkspaceTransaction,
  input: CoordinateEventInput,
  now: Date,
): Promise<EventWindowRow | undefined> {
  const found = (await readEventWindow(transaction, input))[0];
  const pending =
    found === undefined
      ? false
      : (
          await transaction.db
            .select({ one: sql`1` })
            .from(events)
            .where(
              and(
                eq(events.workspaceId, transaction.workspaceId),
                eq(events.keyId, found.id),
                eq(events.status, 'pending'),
              ),
            )
            .limit(1)
        ).length > 0;
  const hasLiveKey = found !== undefined && (found.expires_at > now || pending);
  if (hasLiveKey) return found;
  const state = alias(windows, 'state');
  const pendingEvent = transaction.db
    .select({ one: sql`1` })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, state.workspaceId),
        eq(events.keyId, state.id),
        eq(events.status, 'pending'),
      ),
    );
  const count =
    (
      await transaction.db
        .select({ count: sql<number>`count(*)::integer` })
        .from(state)
        .where(
          and(
            eq(state.workspaceId, transaction.workspaceId),
            or(sql`${state.expiresAt}>${now}`, exists(pendingEvent)),
          ),
        )
    )[0]?.count ?? 0;
  if (count >= EVENT_COORDINATION_LIMITS.activeKeys) return undefined;
  if (found !== undefined) return found;
  const id = generatePersistedId();
  const policy = input.prepared.policy;
  const seconds =
    policy.mode === 'debounce' ? policy.quietSeconds : policy.windowSeconds;
  await transaction.db.insert(windows).values({
    id,
    workspaceId: transaction.workspaceId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    policyHash: input.prepared.policyHash,
    keyHash: sql`${input.prepared.keyHash}`,
    windowStartedAt: now,
    usedCount: 0,
    expiresAt: new Date(now.getTime() + seconds * 1_000),
  });
  return {
    id,
    window_started_at: now,
    used_count: 0,
    expires_at: new Date(now.getTime() + seconds * 1_000),
  };
}
export async function chargeEventWindow(
  transaction: WorkspaceTransaction,
  keyId: string,
  policy: EventCoordinationPolicy,
  window: EventCoordinationWindow,
): Promise<void> {
  const seconds =
    policy.mode === 'debounce' ? policy.quietSeconds : policy.windowSeconds;
  await transaction.db
    .update(windows)
    .set({
      windowStartedAt: new Date(window.startedAt),
      usedCount: window.used + 1,
      expiresAt: new Date(window.startedAt + seconds * 1_000),
    })
    .where(
      and(
        eq(windows.workspaceId, transaction.workspaceId),
        eq(windows.id, keyId),
      ),
    );
}

/** Serialize first-key creation and workspace budgets before any workflow/state locks. */
export async function lockEventCoordination(
  workspaceId: string,
  db: Pick<WorkspaceTransaction['db'], 'execute'>,
) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`pertexo.trigger-coordination:${workspaceId}`}, 81472591))`,
  );
}
