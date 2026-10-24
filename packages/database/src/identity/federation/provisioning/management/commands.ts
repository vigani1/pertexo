import { ADMINISTRATIVE_ROLES } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';
import {claimCommand, completeCommand} from '../../../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../../../tenant-access/transactions.js';
import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../../../tenant-access/workspaces/authority.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from '../../management/authority.js';
import type { FederationScope } from '../../management/contract.js';
import { DirectoryError } from '../contract.js';
import {
  lockDirectoryOrganization,
  lockDirectoryParticipants,
  type DirectoryOrganization,
} from '../authority.js';

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
      await client.query(
        'select id from app.auth_organizations where id=$1 for share',
        [preview.id],
      );
      const row = await organizationForWorkspace(client, scope.workspaceId);
      if (row?.id !== preview.id) throw new DirectoryError('not_found');
      const workspaces = (
        await client.query<DirectoryOrganization['workspaces'][number]>(
          'select workspace_id,default_role from app.auth_organization_workspaces where organization_id=$1 order by workspace_id',
          [preview.id],
        )
      ).rows;
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
      await client.query(
        'update app.auth_organizations set revision=revision+1 where id=$1',
        [organization.id],
      );
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
