import {
  authOrganizations,
  authOrganizationWorkspaces,
} from '../../../../schema/identity/federation/organizations.js';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import { ADMINISTRATIVE_ROLES } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';
import {
  claimCommand,
  completeCommand,
} from '../../../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../../../tenant-access/transactions.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../../../tenant-access/workspaces/authority.queries.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from '../../management/authority.repository.js';
import type { FederationScope } from '../../management/contract.js';
import { DirectoryError } from '../contract.js';
import {
  lockDirectoryOrganization,
  lockDirectoryParticipants,
  type DirectoryOrganization,
} from '../authority.repository.js';

export type DirectoryCommand = FederationScope &
  Readonly<{ idempotencyKey: string; expectedRevision: number }>;
export async function readDirectoryManagement<T>(
  pool: Pool,
  scope: FederationScope,
  read: (
    client: PoolClient,
    organization: DirectoryOrganization,
    options: Readonly<{ canManage: boolean }>,
  ) => Promise<T>,
): Promise<T> {
  return withPlatformTransaction(
    pool,
    async (client) => {
      const role = await withWorkspaceScope(client, scope, (scoped) =>
        readWorkspaceAuthority(scoped, scope.workspaceId, {
          actorId: scope.actorId,
          roles: ADMINISTRATIVE_ROLES,
        }),
      );
      const preview = await organizationForWorkspace(client, scope.workspaceId);
      if (preview === undefined) throw new DirectoryError('not_found');
      // A shared organization lock gives settings one coherent revision without blocking other readers.
      await drizzle(client)
        .select({ id: authOrganizations.id })
        .from(authOrganizations)
        .where(eq(authOrganizations.id, preview.id))
        .for('share')
        .catch(rethrowQueryFailure);
      const row = await organizationForWorkspace(client, scope.workspaceId);
      if (row?.id !== preview.id) throw new DirectoryError('not_found');
      const workspaces = await drizzle(client)
        .select({
          workspace_id: authOrganizationWorkspaces.workspaceId,
          default_role: authOrganizationWorkspaces.defaultRole,
        })
        .from(authOrganizationWorkspaces)
        .where(eq(authOrganizationWorkspaces.organizationId, preview.id))
        .orderBy(asc(authOrganizationWorkspaces.workspaceId))
        .catch(rethrowQueryFailure);
      return read(
        client,
        { ...row, workspaces },
        {
          canManage:
            role === 'owner' && row.control_workspace_id === scope.workspaceId,
        },
      );
    },
    scope.signal === undefined ? {} : { signal: scope.signal },
  );
}

/** Receipts are safe metadata; a first-response secret can only leave through `value`. */
export function runDirectoryCommand<T>(
  pool: Pool,
  input: DirectoryCommand,
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
    ) => Promise<
      Readonly<{ receipt: Readonly<Record<string, unknown>>; value: T }>
    >;
  }>,
): Promise<
  | Readonly<{ replayed: true; receipt: unknown }>
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
        claimCommand(scoped, {
          ...identity,
          request,
          resourceId: generatePersistedId(),
        }),
      );
      if (replay !== null) return { replayed: true, receipt: replay };
      if (organization.revision !== input.expectedRevision)
        throw new DirectoryError('stale');
      const result = await change(client, organization);
      await drizzle(client)
        .update(authOrganizations)
        .set({ revision: sql`${authOrganizations.revision}+1` })
        .where(eq(authOrganizations.id, organization.id))
        .catch(rethrowQueryFailure);
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
