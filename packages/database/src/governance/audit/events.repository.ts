import type { PoolClient } from 'pg';
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
  client: Pick<PoolClient, 'query'>,
  fact: AuditFact,
): Promise<void> {
  return appendAuditFacts(client, [fact]);
}

export async function appendAuditFacts(
  client: Pick<PoolClient, 'query'>,
  facts: readonly AuditFact[],
): Promise<void> {
  if (facts.length === 0) return;
  const rows = facts.map((fact) => ({
    id: generatePersistedId(),
    workspace_id: fact.workspaceId,
    actor_user_id: fact.actorId ?? null,
    action: fact.action,
    target_type: fact.targetType,
    target_id: fact.targetId,
    request_id: fact.requestId ?? null,
    trace_id: fact.traceId ?? null,
    metadata: fact.metadata ?? {},
  }));
  await client.query(
    `insert into app.audit_events
      (id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
     select id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata
     from jsonb_to_recordset($1::jsonb) as fact(
       id uuid,workspace_id uuid,actor_user_id uuid,action text,target_type text,
       target_id uuid,request_id text,trace_id text,metadata jsonb)`,
    [JSON.stringify(rows)],
  );
}
