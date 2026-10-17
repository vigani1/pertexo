import type { PoolClient } from 'pg';
import { generatePersistedId } from '../../platform/persisted-id.js';

type AuditFact = Readonly<{
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
export async function appendAuditFact(
  client: Pick<PoolClient, 'query'>,
  fact: AuditFact,
): Promise<void> {
  await client.query(
    `insert into app.audit_events
      (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      generatePersistedId(),
      fact.workspaceId,
      fact.actorId ?? null,
      fact.action,
      fact.targetType,
      fact.targetId,
      fact.requestId ?? null,
      fact.traceId ?? null,
      JSON.stringify(fact.metadata ?? {}),
    ],
  );
}
