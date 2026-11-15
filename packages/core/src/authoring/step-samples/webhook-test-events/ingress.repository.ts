import type { PoolClient, Pool } from 'pg';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { webhookTestEvents as listeners } from '@pertexo/database/schema';
import type { TestEventReference } from './webhook-test-event.types.js';
import { listenerSelection } from './webhook-test-listeners.repository.js';
import { MINUTE_INTERVAL } from '../../../shared/sql-intervals.repository.js';

export const LISTENER_ATTEMPTS_MAX = 60;
/** How long a received test event stays readable. */
const TEST_EVENT_LIFETIME_MINUTES = 10;

/**
 * What the test address does for an HTTP sender. No member is acting, so these stay off
 * the authority helper; the listener works while its creator could still edit the workflow.
 */

/** The workspace and listener a test address hash belongs to, if any. */
export async function resolveListenerHash(pool: Pool, hash: string) {
  const resolution = await drizzle(pool)
    .execute<{ workspace_id: string; id: string }>(
      sql`select * from app.resolve_webhook_test_event(${hash}::char(64))`,
    )
    .catch(rethrowQueryFailure);
  return resolution.rows[0];
}

export async function readPendingListener(
  client: PoolClient,
  resolved: Readonly<{ workspace_id: string; id: string }>,
  hash: string,
) {
  const result = await drizzle(client)
    .select(listenerSelection)
    .from(listeners)
    .where(
      and(
        eq(listeners.workspaceId, resolved.workspace_id),
        eq(listeners.id, resolved.id),
        eq(listeners.endpointKeyHash, hash),
        isNull(listeners.outputRef),
      ),
    )
    .catch(rethrowQueryFailure);
  return result[0];
}

/** Counts one delivery attempt against a live, unanswered listener; false when none is left. */
export async function takeListenerAttempt(
  pool: Pool,
  reference: TestEventReference,
): Promise<boolean> {
  const allowed = await withTenantScopedClient(
    pool,
    { workspaceId: reference.workspaceId },
    (client) =>
      drizzle(client)
        .update(listeners)
        .set({ attempts: sql`${listeners.attempts}+1` })
        .where(
          and(
            eq(listeners.workspaceId, reference.workspaceId),
            eq(listeners.id, reference.endpointId),
            sql`${listeners.attempts}<${LISTENER_ATTEMPTS_MAX}`,
            sql`${listeners.expiresAt}>clock_timestamp()`,
            isNull(listeners.outputRef),
          ),
        )
        .returning({ id: listeners.id })
        .catch(rethrowQueryFailure),
  );
  return allowed.length === 1;
}

/** Whether a live, unanswered listener has used every attempt. */
export async function listenerAttemptsSpent(
  pool: Pool,
  reference: TestEventReference,
): Promise<boolean> {
  const limited = await withTenantScopedClient(
    pool,
    { workspaceId: reference.workspaceId },
    (client) =>
      drizzle(client)
        .select({ one: sql`1` })
        .from(listeners)
        .where(
          and(
            eq(listeners.workspaceId, reference.workspaceId),
            eq(listeners.id, reference.endpointId),
            sql`${listeners.attempts}>=${LISTENER_ATTEMPTS_MAX}`,
            sql`${listeners.expiresAt}>clock_timestamp()`,
            isNull(listeners.outputRef),
          ),
        )
        .catch(rethrowQueryFailure),
  );
  return limited.length === 1;
}

/** The listener, read before its row lock, matching management's lock order. */
export async function readListener(
  client: PoolClient,
  reference: TestEventReference,
) {
  const result = await drizzle(client)
    .select(listenerSelection)
    .from(listeners)
    .where(
      and(
        eq(listeners.workspaceId, reference.workspaceId),
        eq(listeners.id, reference.endpointId),
      ),
    )
    .catch(rethrowQueryFailure);
  return result[0];
}

export async function storeTestEvent(
  client: PoolClient,
  reference: TestEventReference,
  output: string,
): Promise<void> {
  await drizzle(client)
    .update(listeners)
    .set({
      outputRef: output,
      receivedAt: sql`clock_timestamp()`,
      expiresAt: sql`clock_timestamp()+${TEST_EVENT_LIFETIME_MINUTES}*${MINUTE_INTERVAL}`,
    })
    .where(
      and(
        eq(listeners.workspaceId, reference.workspaceId),
        eq(listeners.id, reference.endpointId),
      ),
    )
    .catch(rethrowQueryFailure);
}
