import type { Pool, PoolClient } from 'pg';
import { withPlatformTransaction } from '../../../tenant-access/transactions.js';
import {
  DirectoryError,
  type DirectoryPrincipal,
  type DirectoryRole,
} from './contract.js';

export type DirectoryWorkspace = Readonly<{
  workspace_id: string;
  default_role: DirectoryRole;
}>;
export type DirectoryOrganization = Readonly<{
  id: string;
  control_workspace_id: string;
  revision: number;
  workspaces: readonly DirectoryWorkspace[];
}>;

/** Workspace locks precede organization and member locks in every identity writer. */
export async function lockDirectoryOrganization(
  client: PoolClient,
  organizationId: string,
): Promise<DirectoryOrganization> {
  const workspaces = (
    await client.query<DirectoryWorkspace>(
      'select workspace_id,default_role from app.auth_organization_workspaces where organization_id=$1 order by workspace_id',
      [organizationId],
    )
  ).rows;
  for (const workspace of workspaces)
    await client.query('select id from app.workspaces where id=$1 for update', [
      workspace.workspace_id,
    ]);
  const organization = (
    await client.query<Omit<DirectoryOrganization, 'workspaces'>>(
      'select id,control_workspace_id,revision from app.auth_organizations where id=$1 for update',
      [organizationId],
    )
  ).rows[0];
  if (organization === undefined) throw new DirectoryError('not_found');
  const current = (
    await client.query<DirectoryWorkspace>(
      'select workspace_id,default_role from app.auth_organization_workspaces where organization_id=$1 order by workspace_id',
      [organizationId],
    )
  ).rows;
  if (
    current.length !== workspaces.length ||
    current.some(
      (workspace, index) =>
        workspace.workspace_id !== workspaces[index]?.workspace_id,
    )
  )
    throw new DirectoryError('stale');
  return { ...organization, workspaces: current };
}

/** A human owner proof must not lock one global user ahead of a later fan-out. */
export async function lockDirectoryParticipants(
  client: PoolClient,
  organizationId: string | undefined,
  actorId: string,
): Promise<void> {
  await client.query(
    `select id from app.users where id=$2 or id in (
    select user_id from app.auth_directory_users where organization_id=$1 and user_id is not null)
    order by id for update`,
    [organizationId ?? null, actorId],
  );
}

export async function authenticateDirectory(
  pool: Pool,
  organizationId: string,
  digest: string,
): Promise<DirectoryPrincipal> {
  return withPlatformTransaction(pool, async (client) => {
    const row = (
      await client.query<{
        credential_id: string;
        control_workspace_id: string;
      }>(
        `select credential.id credential_id,organization.control_workspace_id
       from app.auth_provisioning_credentials credential
       join app.auth_organizations organization on organization.id=credential.organization_id
       join app.workspaces workspace on workspace.id=organization.control_workspace_id
       where credential.organization_id=$1 and credential.secret_digest=$2 and credential.revoked_at is null and workspace.status='active'`,
        [organizationId, digest],
      )
    ).rows[0];
    if (row === undefined) throw new DirectoryError('unauthorized');
    return {
      credentialId: row.credential_id,
      organizationId,
      controlWorkspaceId: row.control_workspace_id,
    };
  });
}

async function requireDirectoryCredential(
  client: PoolClient,
  principal: DirectoryPrincipal,
): Promise<void> {
  const valid = (
    await client.query(
      `select credential.id from app.auth_provisioning_credentials credential
     join app.auth_organizations organization on organization.id=credential.organization_id
     join app.workspaces workspace on workspace.id=organization.control_workspace_id
     where credential.id=$1 and credential.organization_id=$2 and organization.control_workspace_id=$3
     and credential.revoked_at is null and workspace.status='active'`,
      [
        principal.credentialId,
        principal.organizationId,
        principal.controlWorkspaceId,
      ],
    )
  ).rowCount;
  if (valid !== 1) throw new DirectoryError('unauthorized');
}

/** Shared short reads keep each resource and its reference-list ETag consistent. */
export function withDirectoryRead<T>(
  pool: Pool,
  principal: DirectoryPrincipal,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withPlatformTransaction(pool, async (client) => {
    await client.query(
      'select id from app.auth_organizations where id=$1 for share',
      [principal.organizationId],
    );
    await requireDirectoryCredential(client, principal);
    return read(client);
  });
}

/** Revocation and every resource mutation serialize on the same organization. */
export function withDirectoryTransaction<T>(
  pool: Pool,
  principal: DirectoryPrincipal,
  change: (
    client: PoolClient,
    organization: DirectoryOrganization,
  ) => Promise<T>,
): Promise<T> {
  return withPlatformTransaction(pool, async (client) => {
    const organization = await lockDirectoryOrganization(
      client,
      principal.organizationId,
    );
    await requireDirectoryCredential(client, principal);
    const result = await change(client, organization);
    await client.query(
      "update app.auth_provisioning_credentials set last_used_at=clock_timestamp() where id=$1 and (last_used_at is null or last_used_at<clock_timestamp()-interval '1 minute')",
      [principal.credentialId],
    );
    return result;
  });
}
