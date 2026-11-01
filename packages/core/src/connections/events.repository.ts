import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';
import {
  appendAuditFact,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import { connectionEvents } from '@pertexo/database/schema';

type ConnectionEvent = Readonly<{
  workspaceId: string;
  connectionId: string;
  eventType: string;
  actorKind: 'user' | 'worker';
  actorId: string;
  requestId?: string | null | undefined;
  traceId?: string | null | undefined;
  metadata: Readonly<Record<string, unknown>>;
}>;

/** One line in a connection's own history. */
export async function appendConnectionEvent(
  client: PoolClient,
  event: ConnectionEvent,
): Promise<void> {
  await drizzle(client)
    .insert(connectionEvents)
    .values({
      id: generatePersistedId(),
      ...event,
      requestId: event.requestId ?? null,
      traceId: event.traceId ?? null,
    })
    .catch(rethrowQueryFailure);
}

/** What a member did to a connection: in its history and in the audit log. */
export async function recordMemberAction(
  client: PoolClient,
  action: Omit<ConnectionEvent, 'actorKind'>,
): Promise<void> {
  await appendConnectionEvent(client, { ...action, actorKind: 'user' });
  await appendAuditFact(client, {
    workspaceId: action.workspaceId,
    actorId: action.actorId,
    action: action.eventType,
    targetType: 'connection',
    targetId: action.connectionId,
    requestId: action.requestId ?? null,
    traceId: action.traceId ?? null,
    metadata: action.metadata,
  });
}
