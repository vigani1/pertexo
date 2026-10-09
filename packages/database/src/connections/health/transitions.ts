import type { PoolClient } from 'pg';

import { generatePersistedId } from '../../platform/persisted-id.js';
import { mapConnection } from '../records.js';
import type { ConnectionRecord, ConnectionTestOutcome } from '../records.js';

/** Transaction-private revision transitions; callers already own the connection lock. */
export async function revokeConnectionHealth(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
) {
  return client.query<Record<string, unknown>>(
    `update app.connections
    set status='revoked',health_revision=health_revision+1,
      last_health_transition_at=transaction_timestamp(),last_health_transition_source='revoke',updated_at=transaction_timestamp()
    where workspace_id=$1 and id=$2 returning *`,
    [workspaceId, connectionId],
  );
}

export async function rotateConnectionHealth(
  client: PoolClient,
  workspaceId: string,
  connectionId: string,
  secretVersionId: string,
) {
  return client.query<Record<string, unknown>>(
    `update app.connections
    set current_secret_version_id=$1,status='active',last_error_code=null,last_tested_at=null,last_healthy_at=null,
      last_run_observed_at=null,health_revision=health_revision+1,
      last_health_transition_at=transaction_timestamp(),last_health_transition_source='rotation',updated_at=transaction_timestamp()
    where workspace_id=$2 and id=$3 returning *`,
    [secretVersionId, workspaceId, connectionId],
  );
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
  if (
    current.status === 'revoked' ||
    current.currentSecretVersionId !== input.secretVersionId ||
    input.healthRevision === undefined
  )
    return current;
  const revision = await client.query<{ health_revision: string }>(
    'select health_revision::text from app.connections where workspace_id=$1 and id=$2',
    [current.workspaceId, current.id],
  );
  if (revision.rows[0]?.health_revision !== input.healthRevision)
    return current;
  const definitive = !outcome.ok && outcome.reauthorizationRequired;
  const nextStatus = outcome.ok
    ? 'active'
    : definitive
      ? 'reauthorization_required'
      : current.status;
  const updated = await client.query<Record<string, unknown>>(
    `update app.connections
    set status=$1::varchar,last_tested_at=transaction_timestamp(),
      last_healthy_at=case when $2 then transaction_timestamp() else last_healthy_at end,
      last_error_code=case when status='reauthorization_required' and not $2 and not $6 then last_error_code else $3 end,
      health_revision=health_revision+case when $2 or (status<>'reauthorization_required' and $1::varchar='reauthorization_required') then 1 else 0 end,
      last_health_transition_at=case when $2 or status<>$1::varchar then transaction_timestamp() else last_health_transition_at end,
      last_health_transition_source=case when $2 or status<>$1::varchar then 'test' else last_health_transition_source end,
      updated_at=transaction_timestamp()
    where workspace_id=$4 and id=$5 returning *`,
    [
      nextStatus,
      outcome.ok,
      outcome.ok ? null : outcome.errorCode,
      current.workspaceId,
      current.id,
      definitive,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined)
    throw new Error('Connection test health update returned no row');
  if (outcome.ok || current.status !== nextStatus) {
    await client.query(
      `insert into app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,request_id,trace_id,metadata)
      values($1,$2,$3,$4,'user',$5,$6,$7,$8::jsonb)`,
      [
        generatePersistedId(),
        current.workspaceId,
        current.id,
        outcome.ok
          ? 'connection.health_changed'
          : 'connection.reauthorization_required',
        input.actorId,
        input.requestId,
        input.traceId,
        JSON.stringify({
          source: 'test',
          status: nextStatus,
          ...(outcome.ok ? {} : { reasonCode: outcome.errorCode }),
        }),
      ],
    );
  }
  return mapConnection(row);
}
