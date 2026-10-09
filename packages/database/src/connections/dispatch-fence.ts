import type { PoolClient } from 'pg';

import { generatePersistedId } from '../platform/persisted-id.js';

/** The connection secret a run or preview was given to use. */
export type ConnectionFence = Readonly<{
  connectionId: string;
  providerKey: string;
  authType: string;
  secretVersionId: string;
}>;

/**
 * Whether the secret may still be used: the workspace and the connection are
 * active and the connection still has this provider, auth type and current
 * secret. Holds both rows until the transaction ends.
 */
export async function isConnectionFenceCurrent(
  client: Pick<PoolClient, 'query'>,
  workspaceId: string,
  fence: ConnectionFence,
): Promise<boolean> {
  const workspace = await client.query(
    "select 1 from app.workspaces where id=$1 and status='active' for share",
    [workspaceId],
  );
  if (workspace.rowCount !== 1) return false;
  const connection = await client.query(
    `select 1 from app.connections
     where workspace_id=$1 and id=$2 and provider_key=$3 and auth_type=$4
       and current_secret_version_id=$5 and status='active'
     for share`,
    [
      workspaceId,
      fence.connectionId,
      fence.providerKey,
      fence.authType,
      fence.secretVersionId,
    ],
  );
  return connection.rowCount === 1;
}

/** Records that a worker read a connection's secret, and why. */
export async function recordCredentialAccess(
  client: Pick<PoolClient, 'query'>,
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    secretVersionId: string;
    workerId: string;
    traceId: string | null;
    purpose: string;
  }>,
): Promise<void> {
  await client.query(
    `insert into app.connection_events
       (id, workspace_id, connection_id, event_type, actor_kind, actor_id,
        trace_id, metadata)
     values ($1, $2, $3, 'connection.credential_accessed', 'worker', $4, $5,
             jsonb_build_object('purpose', $6::text, 'secretVersionId', $7::text))`,
    [
      generatePersistedId(),
      input.workspaceId,
      input.connectionId,
      input.workerId,
      input.traceId,
      input.purpose,
      input.secretVersionId,
    ],
  );
}
