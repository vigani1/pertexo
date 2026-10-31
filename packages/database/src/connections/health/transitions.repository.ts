import { connectionTestStatus } from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';
import { rethrowQueryFailure } from '../../platform/query-errors.js';

import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { connectionEvents, connections } from '../../schema/connections.js';
import type {
  ConnectionRecord,
  ConnectionStatus,
  ConnectionTestOutcome,
} from '../contract.js';
import { connectionFields } from '../records.queries.js';

/** Transaction-private revision transitions; callers already own the connection lock. */
export async function revokeConnectionHealth(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
) {
  return drizzle(client)
    .update(connections)
    .set({
      status: 'revoked',
      healthRevision: sql`${connections.healthRevision}+1`,
      lastHealthTransitionAt: sql`transaction_timestamp()`,
      lastHealthTransitionSource: 'revoke',
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .returning(connectionFields);
}

export async function rotateConnectionHealth(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
  secretVersionId: string,
  next: Readonly<{ status: ConnectionStatus; lastErrorCode: string | null }>,
) {
  return drizzle(client)
    .update(connections)
    .set({
      currentSecretVersionId: secretVersionId,
      status: next.status,
      lastErrorCode: next.lastErrorCode,
      lastTestedAt: null,
      lastHealthyAt: null,
      lastRunObservedAt: null,
      healthRevision: sql`${connections.healthRevision}+1`,
      lastHealthTransitionAt: sql`transaction_timestamp()`,
      lastHealthTransitionSource: 'rotation',
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    )
    .returning(connectionFields);
}

export async function applyCurrentConnectionTestHealth(
  client: PoolClient,
  input: Readonly<{
    current: ConnectionRecord;
    secretVersionId: string;
    healthRevision: string | undefined;
    outcome: ConnectionTestOutcome;
    actorId: string;
    requestId: string | null;
    traceId: string | null;
  }>,
): Promise<ConnectionRecord> {
  const { current, outcome } = input;
  const staleObservation =
    current.status === 'revoked' ||
    current.currentSecretVersionId !== input.secretVersionId ||
    input.healthRevision === undefined;
  if (staleObservation) return current;
  const db = drizzle(client);
  const predicate = and(
    eq(connections.workspaceId, current.workspaceId),
    eq(connections.id, current.id),
  );
  const [revision] = await db
    .select({
      healthRevision: sql<string>`${connections.healthRevision}::text`,
    })
    .from(connections)
    .where(predicate)
    .catch(rethrowQueryFailure);
  if (revision?.healthRevision !== input.healthRevision) return current;
  const definitive = !outcome.ok && outcome.reauthorizationRequired;
  const nextStatus = connectionTestStatus(current, { outcome, definitive });
  const [row] = await db
    .update(connections)
    .set({
      status: nextStatus,
      lastTestedAt: sql`transaction_timestamp()`,
      lastHealthyAt: sql`case when ${outcome.ok} then transaction_timestamp() else ${connections.lastHealthyAt} end`,
      lastErrorCode: sql`case when ${connections.status}='reauthorization_required' and not ${outcome.ok} and not ${definitive} then ${connections.lastErrorCode} else ${outcome.ok ? null : outcome.errorCode} end`,
      healthRevision: sql`${connections.healthRevision}+case when ${outcome.ok} or (${connections.status}<>'reauthorization_required' and ${nextStatus}::varchar='reauthorization_required') then 1 else 0 end`,
      lastHealthTransitionAt: sql`case when ${outcome.ok} or ${connections.status}<>${nextStatus}::varchar then transaction_timestamp() else ${connections.lastHealthTransitionAt} end`,
      lastHealthTransitionSource: sql`case when ${outcome.ok} or ${connections.status}<>${nextStatus}::varchar then 'test' else ${connections.lastHealthTransitionSource} end`,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(predicate)
    .returning(connectionFields)
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new Error('Connection test health update returned no row');
  if (outcome.ok || current.status !== nextStatus) {
    await db
      .insert(connectionEvents)
      .values({
        id: generatePersistedId(),
        workspaceId: current.workspaceId,
        connectionId: current.id,
        eventType: outcome.ok
          ? 'connection.health_changed'
          : 'connection.reauthorization_required',
        actorKind: 'user',
        actorId: input.actorId,
        requestId: input.requestId,
        traceId: input.traceId,
        metadata: {
          source: 'test',
          status: nextStatus,
          ...(outcome.ok ? {} : { reasonCode: outcome.errorCode }),
        },
      })
      .catch(rethrowQueryFailure);
  }
  return Object.freeze(row);
}
