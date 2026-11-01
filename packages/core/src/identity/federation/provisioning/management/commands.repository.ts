import { authOrganizations } from '@pertexo/database/schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import {
  BROWSABLE_WORKSPACE_STATUSES,
  rolesForCapability,
  type Role,
} from '@pertexo/workflow-model';
import type {
  DirectoryAdoptionPreview,
  DirectoryAdoptionQuery,
} from '@pertexo/contracts';
import type { Pool, PoolClient } from 'pg';
import {
  generatePersistedId,
  withPlatformTransaction,
} from '@pertexo/database/platform';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../../../shared/authority.queries.js';
import { withWorkspaceAccess } from '../../../../shared/workspace-access.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from '../../management/authority.repository.js';
import { advanceOrganization } from '../../management/commands.repository.js';
import type {
  FederationCommand,
  FederationScope,
} from '../../management/contract.js';
import { DirectoryError } from '../errors.js';
import {
  directoryWorkspaces,
  lockDirectoryOrganization,
  lockDirectoryParticipants,
} from '../authority.repository.js';
import type { DirectoryOrganization } from '../contract.js';
import { previewDirectoryAdoption } from './adoption.queries.js';
type ManagedOrganization = Readonly<{
  organization: DirectoryOrganization;
  canManage: boolean;
}>;

/** A shared organization lock gives a read one coherent revision without blocking other readers. */
async function readManagedOrganization(
  client: PoolClient,
  workspaceId: string,
  role: Role,
): Promise<ManagedOrganization> {
  const preview = await organizationForWorkspace(client, workspaceId);
  if (preview === undefined) throw new DirectoryError('not_found');
  await drizzle(client)
    .select({ id: authOrganizations.id })
    .from(authOrganizations)
    .where(eq(authOrganizations.id, preview.id))
    .for('share')
    .catch(rethrowQueryFailure);
  const row = await organizationForWorkspace(client, workspaceId);
  if (row?.id !== preview.id) throw new DirectoryError('not_found');
  return {
    organization: {
      ...row,
      workspaces: await directoryWorkspaces(client, preview.id),
    },
    canManage: role === 'owner' && row.control_workspace_id === workspaceId,
  };
}

/** What an owner or admin may see of the directory. These reads lock, so `change`. */
export function readDirectoryManagement<T>(
  pool: Pool,
  scope: FederationScope,
  read: (
    client: PoolClient,
    organization: DirectoryOrganization,
    options: Readonly<{ canManage: boolean }>,
  ) => Promise<T>,
): Promise<T> {
  return withWorkspaceAccess(
    pool,
    scope,
    {
      mode: 'change',
      capability: 'member:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
    },
    async (client, role) => {
      const { organization, canManage } = await readManagedOrganization(
        client,
        scope.workspaceId,
        role,
      );
      return read(client, organization, { canManage });
    },
  );
}

/**
 * Doesn't fit `withWorkspaceAccess`: the preview reads a membership in the
 * target workspace, which needs a scope of its own, and a scope can't be
 * installed inside the helper's.
 */
export function readDirectoryAdoption(
  pool: Pool,
  scope: FederationScope,
  query: DirectoryAdoptionQuery,
): Promise<DirectoryAdoptionPreview> {
  return withPlatformTransaction(
    pool,
    async (client) => {
      const role = await withWorkspaceScope(client, scope, (scoped) =>
        readWorkspaceAuthority(scoped, scope.workspaceId, {
          actorId: scope.actorId,
          roles: rolesForCapability('member:read'),
          allowedStatuses: BROWSABLE_WORKSPACE_STATUSES,
        }),
      );
      const { organization, canManage } = await readManagedOrganization(
        client,
        scope.workspaceId,
        role,
      );
      return previewDirectoryAdoption(client, organization, {
        canManage,
        query,
      });
    },
    scope.signal === undefined ? {} : { signal: scope.signal },
  );
}

/**
 * Receipts are safe metadata; a first-response secret can only leave through `value`.
 * Doesn't fit `withWorkspaceAccess`: it locks every linked workspace, the
 * organization and every bound user before authority, in the order a directory
 * fan-out uses, and a fan-out installs a scope per workspace.
 */
export function runDirectoryCommand<
  Receipt extends Readonly<Record<string, unknown>>,
  T,
>(
  pool: Pool,
  input: FederationCommand,
  {
    operation,
    request,
    change,
  }: Readonly<{
    operation: string;
    request: unknown;
    change: (
      client: PoolClient,
      organization: DirectoryOrganization,
    ) => Promise<Readonly<{ receipt: Receipt; value: T }>>;
  }>,
): Promise<
  | Readonly<{ replayed: true; receipt: Receipt }>
  | Readonly<{ replayed: false; value: T }>
> {
  return withPlatformTransaction(
    pool,
    async (client) => {
      const preview = await organizationForWorkspace(client, input.workspaceId);
      if (preview?.control_workspace_id !== input.workspaceId)
        throw new DirectoryError('forbidden');
      const organization = await lockDirectoryOrganization(client, preview.id);
      await lockDirectoryParticipants(client, organization.id, input.actorId);
      const role = await withWorkspaceScope(client, input, (scoped) =>
        lockWorkspaceAuthority(scoped, input.workspaceId, input.actorId, [
          'owner',
        ]),
      );
      if (role !== 'owner') throw new DirectoryError('forbidden');
      const identity = {
        workspaceId: input.workspaceId,
        scope: input.actorId,
        operation,
        idempotencyKey: input.idempotencyKey,
      };
      const replay = await withWorkspaceScope(client, input, (scoped) =>
        claimCommand<Receipt>(scoped, {
          ...identity,
          request,
          resourceId: generatePersistedId(),
        }),
      );
      if (replay !== null) return { replayed: true, receipt: replay };
      if (organization.revision !== input.expectedRevision)
        throw new DirectoryError('stale');
      const result = await change(client, organization);
      await advanceOrganization(client, organization);
      await withWorkspaceScope(client, input, (scoped) =>
        completeCommand(scoped, identity, result.receipt),
      );
      return { replayed: false, value: result.value };
    },
    input.signal === undefined ? {} : { signal: input.signal },
  );
}
export async function auditDirectoryManagement(
  client: PoolClient,
  input: FederationScope,
  {
    organizationId,
    action,
    targetId,
  }: Readonly<{ organizationId: string; action: string; targetId: string }>,
): Promise<void> {
  await recordFederationAudit(client, input, {
    action,
    targetId: organizationId,
    metadata: {
      resourceId: targetId,
    },
  });
}
