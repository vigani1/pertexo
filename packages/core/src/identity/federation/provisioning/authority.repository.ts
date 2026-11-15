import {
  workspaces,
  users,
  authOrganizations,
  authOrganizationWorkspaces,
  authDirectoryUsers,
  authProvisioningCredentials,
} from '@pertexo/database/schema';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { DirectoryPrincipal } from './directory-provisioning.types.js';
import { MINUTE_INTERVAL } from '../../../shared/sql-intervals.repository.js';

// A credential's last use is written at most this often.
const LAST_USED_WRITE_MINUTES = 1;
const LAST_USED_WRITE_INTERVAL = sql`${LAST_USED_WRITE_MINUTES}*${MINUTE_INTERVAL}`;

export async function lockOrganizationRow(
  client: PoolClient,
  organizationId: string,
) {
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
  return organization;
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

/** The live credential with this digest, for an active control workspace. */
export async function findActiveCredential(
  client: PoolClient,
  organizationId: string,
  digest: string,
) {
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
  return row;
}

/** Every credential that still matches the principal; exactly one means it's valid. */
export async function readPrincipalCredentials(
  client: PoolClient,
  principal: DirectoryPrincipal,
) {
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
  return valid;
}

export async function shareLockOrganization(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  await drizzle(client)
    .select({ id: authOrganizations.id })
    .from(authOrganizations)
    .where(eq(authOrganizations.id, organizationId))
    .for('share')
    .catch(rethrowQueryFailure);
}

/** Writes the credential's last use, at most once a minute. */
export async function touchCredential(
  client: PoolClient,
  credentialId: string,
): Promise<void> {
  await drizzle(client)
    .update(authProvisioningCredentials)
    .set({ lastUsedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(authProvisioningCredentials.id, credentialId),
        or(
          isNull(authProvisioningCredentials.lastUsedAt),
          sql`${authProvisioningCredentials.lastUsedAt}<clock_timestamp()-${LAST_USED_WRITE_INTERVAL}`,
        ),
      ),
    )
    .catch(rethrowQueryFailure);
}

export function directoryWorkspaces(
  client: PoolClient,
  organizationId: string,
) {
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
      organization_id: authOrganizations.id,
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
