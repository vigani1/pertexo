import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { auditEvents } from '../../schema/foundation.js';
import { generatePersistedId } from '../../platform/persisted-id.js';

export type AuditFact = Readonly<{
  workspaceId: string;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  requestId?: string | null;
  traceId?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}>;

/** Call inside the transaction that performs the action; never pass payloads. */
export function appendAuditFact(
  client: PoolClient,
  fact: AuditFact,
): Promise<void> {
  return appendAuditFacts(client, [fact]);
}

export async function appendAuditFacts(
  client: PoolClient,
  facts: readonly AuditFact[],
): Promise<void> {
  if (facts.length === 0) return;
  const rows = facts.map((fact) => ({
    id: generatePersistedId(),
    workspaceId: fact.workspaceId,
    actorUserId: fact.actorId ?? null,
    action: fact.action,
    targetType: fact.targetType,
    targetId: fact.targetId,
    requestId: fact.requestId ?? null,
    traceId: fact.traceId ?? null,
    metadata: fact.metadata ?? {},
  }));
  await drizzle(client)
    .insert(auditEvents)
    .values(rows)
    .catch(rethrowQueryFailure);
}
