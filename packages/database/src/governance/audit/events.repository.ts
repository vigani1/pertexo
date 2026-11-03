import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { auditEvents } from '../../schema/governance/audit-events.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import type { WorkspaceTransaction } from '../../tenant-access/transactions.js';

/** A checked-out client or a workspace transaction; the fact joins its work. */
type AuditWriter = PoolClient | Pick<WorkspaceTransaction, 'db'>;

export type AuditMetadata = Readonly<Record<string, unknown>>;

export type AuditFact = Readonly<{
  /** Set only when another record already names this fact. */
  id?: string;
  workspaceId: string;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  requestId?: string | null;
  traceId?: string | null;
  metadata?: AuditMetadata;
}>;

/** Call inside the transaction that performs the action; never pass payloads. */
export function appendAuditFact(
  writer: AuditWriter,
  fact: AuditFact,
): Promise<void> {
  return appendAuditFacts(writer, [fact]);
}

export async function appendAuditFacts(
  writer: AuditWriter,
  facts: readonly AuditFact[],
): Promise<void> {
  if (facts.length === 0) return;
  const rows = facts.map((fact) => ({
    id: fact.id ?? generatePersistedId(),
    workspaceId: fact.workspaceId,
    actorUserId: fact.actorId ?? null,
    action: fact.action,
    targetType: fact.targetType,
    targetId: fact.targetId,
    requestId: fact.requestId ?? null,
    traceId: fact.traceId ?? null,
    metadata: fact.metadata ?? {},
  }));
  await ('db' in writer ? writer.db : drizzle(writer))
    .insert(auditEvents)
    .values(rows)
    .catch(rethrowQueryFailure);
}
