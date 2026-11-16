import type { Pool, PoolClient } from 'pg';
import { setOrganizationContext } from '@pertexo/database/primitives';
import { withPlatformTransaction } from '@pertexo/database/platform';
import { lockWorkspaceRow } from '../../../shared/access/authority.repository.js';
import { DirectoryError } from './directory.errors.js';
import type {
  DirectoryOrganization,
  DirectoryPrincipal,
} from './directory-provisioning.types.js';
import {
  directoryWorkspaces,
  findActiveCredential,
  lockOrganizationRow,
  readPrincipalCredentials,
  shareLockOrganization,
  touchCredential,
} from './authority.repository.js';

/** Workspace locks precede organization and member locks in every identity writer. */
export async function lockDirectoryOrganization(
  client: PoolClient,
  organizationId: string,
): Promise<DirectoryOrganization> {
  const linkedWorkspaces = await directoryWorkspaces(client, organizationId);
  for (const workspace of linkedWorkspaces)
    await lockWorkspaceRow(client, workspace.workspace_id);
  const organization = await lockOrganizationRow(client, organizationId);
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

export async function authenticateDirectory(
  pool: Pool,
  organizationId: string,
  digest: string,
): Promise<DirectoryPrincipal> {
  return withPlatformTransaction(pool, async (client) => {
    const row = await findActiveCredential(client, organizationId, digest);
    if (row === undefined) throw new DirectoryError('unauthorized');
    return {
      credentialId: row.credential_id,
      organizationId: row.organization_id,
      controlWorkspaceId: row.control_workspace_id,
    };
  });
}

async function requireDirectoryCredential(
  client: PoolClient,
  principal: DirectoryPrincipal,
) {
  const valid = await readPrincipalCredentials(client, principal);
  const [credential] = valid;
  if (valid.length !== 1 || credential === undefined)
    throw new DirectoryError('unauthorized');
  return credential;
}

/**
 * Shared short reads keep each resource and its reference-list ETag consistent.
 * SCIM has a credential, not a member, behind it: this and the next stay off
 * `withWorkspaceAccess`, and check the credential themselves.
 */
export function withDirectoryRead<T>(
  pool: Pool,
  principal: DirectoryPrincipal,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withPlatformTransaction(pool, async (client) => {
    await shareLockOrganization(client, principal.organizationId);
    const credential = await requireDirectoryCredential(client, principal);
    await setOrganizationContext(client, credential.organization_id);
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
    const credential = await requireDirectoryCredential(client, principal);
    await setOrganizationContext(client, credential.organization_id);
    const organization = await lockDirectoryOrganization(
      client,
      credential.organization_id,
    );
    await requireDirectoryCredential(client, principal);
    const result = await change(client, organization);
    await touchCredential(client, principal.credentialId);
    return result;
  });
}
