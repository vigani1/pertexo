import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

const OAUTH2_SETTINGS = {
  grantType: 'authorization_code',
  authorizationUrl: 'https://id.example.com/authorize',
  authorizationParameters: {},
  pkce: 's256',
  tokenUrl: 'https://id.example.com/token',
  clientId: 'storage-client',
  scope: 'read',
  clientAuthentication: 'basic',
  tokenParameters: {},
  requestHosts: { mode: 'any' },
};

export type StoredConnection = Readonly<{
  connectionId: string;
  secretVersionId: string;
  tokenId: string;
  workspaceId: string;
  ownerId: string;
}>;

const sealedColumns = (marker: string) => ({
  kms: marker,
  key: Buffer.from(`key-${marker}`).toString('base64url'),
  ciphertext: Buffer.from(`ct-${marker}`).toString('base64url'),
  nonce: 'A'.repeat(16),
  tag: 'A'.repeat(22),
});

/** A user and workspace, stored as a database superuser would see them. */
export async function seedWorkspace(
  admin: Pool,
): Promise<Readonly<{ workspaceId: string; ownerId: string }>> {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  await admin.query(
    "insert into app.users(id,email,display_name,status) values($1,$2,'OAuth2 owner','active')",
    [ownerId, `${ownerId}@example.test`],
  );
  await admin.query(
    "insert into app.workspaces(id,name,slug,status,created_by) values($1,'OAuth2 storage',$2,'active',$3)",
    [workspaceId, `oauth2-${workspaceId}`, ownerId],
  );
  await admin.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
    [workspaceId, ownerId],
  );
  return { workspaceId, ownerId };
}

async function insertConnection(
  client: PoolClient,
  workspace: Readonly<{ workspaceId: string; ownerId: string }>,
  ids: Readonly<{ connectionId: string; secretVersionId: string }>,
): Promise<void> {
  const sealed = sealedColumns('alias/oauth2-client');
  await client.query('begin');
  try {
    await insertBoth(client, workspace, ids, sealed);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  }
}

async function insertBoth(
  client: PoolClient,
  workspace: Readonly<{ workspaceId: string; ownerId: string }>,
  ids: Readonly<{ connectionId: string; secretVersionId: string }>,
  sealed: ReturnType<typeof sealedColumns>,
): Promise<void> {
  await client.query(
    "insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by) values($1,$2,'http',$3,'oauth2','active',$4,$5)",
    [
      ids.connectionId,
      workspace.workspaceId,
      `OAuth2 ${ids.connectionId}`,
      ids.secretVersionId,
      workspace.ownerId,
    ],
  );
  await client.query(
    'insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      ids.secretVersionId,
      workspace.workspaceId,
      ids.connectionId,
      sealed.kms,
      sealed.key,
      sealed.ciphertext,
      sealed.nonce,
      sealed.tag,
      workspace.ownerId,
    ],
  );
}

/** One OAuth2 connection with a row in each of the three new tables. */
export async function seedOAuth2Connection(
  admin: Pool,
  workspace: Readonly<{ workspaceId: string; ownerId: string }>,
  tokenKeyReference = 'alias/oauth2-token',
): Promise<StoredConnection> {
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  const tokenId = randomUUID();
  const client = await admin.connect();
  try {
    await insertConnection(client, workspace, {
      connectionId,
      secretVersionId,
    });
  } finally {
    client.release();
  }
  const { workspaceId, ownerId } = workspace;
  await admin.query(
    'insert into app.connection_oauth2_clients(workspace_id,connection_id,secret_version_id,settings) values($1,$2,$3,$4)',
    [
      workspaceId,
      connectionId,
      secretVersionId,
      JSON.stringify(OAUTH2_SETTINGS),
    ],
  );
  await insertTokenRow(admin, {
    tokenId,
    workspaceId,
    connectionId,
    secretVersionId,
    tokenKeyReference,
  });
  await admin.query(
    "insert into app.connection_oauth2_authorizations(workspace_id,connection_id,state_digest,binding_digest,started_by,secret_version_id,expires_at) values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '600 seconds')",
    [
      workspaceId,
      connectionId,
      randomBytes(32),
      randomBytes(32),
      ownerId,
      secretVersionId,
    ],
  );
  return { connectionId, secretVersionId, tokenId, workspaceId, ownerId };
}

export async function insertTokenRow(
  admin: Pool | PoolClient,
  row: Readonly<{
    tokenId: string;
    workspaceId: string;
    connectionId: string;
    secretVersionId: string;
    tokenKeyReference: string;
  }>,
): Promise<void> {
  const sealed = sealedColumns(row.tokenKeyReference);
  await admin.query(
    `insert into app.connection_oauth2_tokens
       (id,workspace_id,connection_id,secret_version_id,kms_key_reference,encrypted_data_key,
        ciphertext,nonce,auth_tag,authorized_at,issued_at,access_token_expires_at,renewable)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),clock_timestamp(),null,true)`,
    [
      row.tokenId,
      row.workspaceId,
      row.connectionId,
      row.secretVersionId,
      sealed.kms,
      sealed.key,
      sealed.ciphertext,
      sealed.nonce,
      sealed.tag,
    ],
  );
}

export const OAUTH2_TABLES = [
  'connection_oauth2_clients',
  'connection_oauth2_tokens',
  'connection_oauth2_authorizations',
] as const;

/** How many rows of this workspace each new table holds, past row security. */
export async function rowCounts(
  admin: Pool,
  workspaceId: string,
): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const table of OAUTH2_TABLES) {
    const { rows } = await admin.query<{ count: number }>(
      `select count(*)::int as count from app.${table} where workspace_id=$1`,
      [workspaceId],
    );
    counts[table] = rows[0]?.count ?? 0;
  }
  return counts;
}
