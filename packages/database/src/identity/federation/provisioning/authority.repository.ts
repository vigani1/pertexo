import { workspaces, users } from '../../../schema/foundation.js';
import {
  authOrganizations,
  authOrganizationWorkspaces,
} from '../../../schema/identity/federation/organizations.js';
import { authDirectoryUsers } from '../../../schema/identity/federation/directory/users.js';
import { authProvisioningCredentials } from '../../../schema/identity/federation/directory/credentials.js';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
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
  const linkedWorkspaces = await directoryWorkspaces(client, organizationId);
  for (const workspace of linkedWorkspaces)
    await drizzle(client)
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.workspace_id))
      .for('update')
      .catch(rethrowQueryFailure);
  const [organization] = await drizzle(client)
    .select({
      id: authOrganizations.id,
      control_workspace_id: authOrganizations.controlWorkspaceId,
      revision: authOrganizations.revision,
    })
    .from(authOrganizations)
    .where(eq(authOrganizations.id, organizationId))
    .for('update')
    .catch(rethrowQueryFailure);
  if (organization === undefined) throw new DirectoryError('not_found');
  const current = await directoryWorkspaces(client, organizationId);
  if (
    current.length !== linkedWorkspaces.length ||
    current.some(
      (workspace, index) =>
        workspace.workspace_id !== linkedWorkspaces[index]?.workspace_id,
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
  const db = drizzle(client);
  const boundUsers = db
    .select({ id: authDirectoryUsers.userId })
    .from(authDirectoryUsers)
    .where(
      and(
        eq(
          authDirectoryUsers.organizationId,
          sql`${organizationId ?? null}::uuid`,
        ),
        isNotNull(authDirectoryUsers.userId),
      ),
    );
  await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.id, actorId), inArray(users.id, boundUsers)))
    .orderBy(asc(users.id))
    .for('update')
    .catch(rethrowQueryFailure);
}

export async function authenticateDirectory(
  pool: Pool,
  organizationId: string,
  digest: string,
): Promise<DirectoryPrincipal> {
  return withPlatformTransaction(pool, async (client) => {
    const [row] = await credentialQuery(client)
      .where(
        and(
          eq(authProvisioningCredentials.organizationId, organizationId),
          eq(authProvisioningCredentials.secretDigest, digest),
          isNull(authProvisioningCredentials.revokedAt),
          eq(workspaces.status, 'active'),
        ),
      )
      .catch(rethrowQueryFailure);
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
  const valid = await credentialQuery(client)
    .where(
      and(
        eq(authProvisioningCredentials.id, principal.credentialId),
        eq(
          authProvisioningCredentials.organizationId,
          principal.organizationId,
        ),
        eq(authOrganizations.controlWorkspaceId, principal.controlWorkspaceId),
        isNull(authProvisioningCredentials.revokedAt),
        eq(workspaces.status, 'active'),
      ),
    )
    .catch(rethrowQueryFailure);
  if (valid.length !== 1) throw new DirectoryError('unauthorized');
}

/** Shared short reads keep each resource and its reference-list ETag consistent. */
export function withDirectoryRead<T>(
  pool: Pool,
  principal: DirectoryPrincipal,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withPlatformTransaction(pool, async (client) => {
    await drizzle(client)
      .select({ id: authOrganizations.id })
      .from(authOrganizations)
      .where(eq(authOrganizations.id, principal.organizationId))
      .for('share')
      .catch(rethrowQueryFailure);
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
    await drizzle(client)
      .update(authProvisioningCredentials)
      .set({ lastUsedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(authProvisioningCredentials.id, principal.credentialId),
          or(
            isNull(authProvisioningCredentials.lastUsedAt),
            sql`${authProvisioningCredentials.lastUsedAt}<clock_timestamp()-interval '1 minute'`,
          ),
        ),
      )
      .catch(rethrowQueryFailure);
    return result;
  });
}

function directoryWorkspaces(client: PoolClient, organizationId: string) {
  return drizzle(client)
    .select({
      workspace_id: authOrganizationWorkspaces.workspaceId,
      default_role: authOrganizationWorkspaces.defaultRole,
    })
    .from(authOrganizationWorkspaces)
    .where(eq(authOrganizationWorkspaces.organizationId, organizationId))
    .orderBy(asc(authOrganizationWorkspaces.workspaceId))
    .catch(rethrowQueryFailure);
}
function credentialQuery(client: PoolClient) {
  return drizzle(client)
    .select({
      credential_id: authProvisioningCredentials.id,
      control_workspace_id: authOrganizations.controlWorkspaceId,
    })
    .from(authProvisioningCredentials)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authProvisioningCredentials.organizationId),
    )
    .innerJoin(
      workspaces,
      eq(workspaces.id, authOrganizations.controlWorkspaceId),
    );
}
