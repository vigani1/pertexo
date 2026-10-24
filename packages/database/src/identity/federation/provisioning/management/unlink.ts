import { removeDirectoryFolderGrants } from '../../../../tenant-access/resources/revocation.repository.js';
import type { Pool } from 'pg';
import {
  claimCommand,
  completeCommand,
} from '../../../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../../../tenant-access/workspaces/authority.queries.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from '../../management/authority.js';
import {
  lockDirectoryOrganization,
  lockDirectoryParticipants,
} from '../authority.js';
import { DirectoryError } from '../contract.js';
import { DIRECTORY_LIMITS } from '../limits.js';
import type { DirectoryCommand } from './commands.js';
import { detachDirectoryMemberships } from './detach.js';

export async function unlinkDirectoryWorkspace(
  pool: Pool,
  input: DirectoryCommand & Readonly<{ targetWorkspaceId: string }>,
): Promise<void> {
  await withPlatformTransaction(pool, async (client) => {
    // The workspace remains the command's receipt authority even after unlinking.
    // Lock the receipt workspace before deciding whether the old link still exists.
    const preview = await organizationForWorkspace(client, input.workspaceId);
    if (preview === undefined) {
      await client.query(
        'select id from app.workspaces where id=$1 for update',
        [input.workspaceId],
      );
    }
    const organization =
      preview === undefined
        ? undefined
        : await lockDirectoryOrganization(client, preview.id);
    await lockDirectoryParticipants(client, organization?.id, input.actorId);
    await withWorkspaceScope(client, input, (scoped) =>
      lockWorkspaceAuthority(scoped, input.workspaceId, input.actorId, [
        'owner',
      ]),
    );
    const identity = {
      workspaceId: input.workspaceId,
      scope: input.actorId,
      operation: 'identity.directory.workspace.unlink',
      idempotencyKey: input.idempotencyKey,
    };
    const replay = await withWorkspaceScope(client, input, (scoped) =>
      claimCommand(scoped, {
        ...identity,
        request: {
          targetWorkspaceId: input.targetWorkspaceId,
          expectedRevision: input.expectedRevision,
        },
        resourceId: generatePersistedId(),
      }),
    );
    if (replay !== null) return;
    if (organization === undefined) throw new DirectoryError('not_found');
    const unlinkRefused =
      organization.control_workspace_id === input.targetWorkspaceId ||
      (input.workspaceId !== organization.control_workspace_id &&
        input.workspaceId !== input.targetWorkspaceId);
    if (unlinkRefused) throw new DirectoryError('forbidden');
    if (
      !organization.workspaces.some(
        (workspace) => workspace.workspace_id === input.targetWorkspaceId,
      )
    )
      throw new DirectoryError('not_found');
    if (organization.revision !== input.expectedRevision)
      throw new DirectoryError('stale');
    await detachDirectoryMemberships(client, organization.id, {
      workspaceId: input.targetWorkspaceId,
      limit: DIRECTORY_LIMITS.users,
      actorId: input.actorId,
    });
    await removeDirectoryFolderGrants(client, organization.id, [
      input.targetWorkspaceId,
    ]);
    await client.query(
      'delete from app.auth_organization_workspaces where organization_id=$1 and workspace_id=$2',
      [organization.id, input.targetWorkspaceId],
    );
    await client.query(
      'update app.auth_organizations set revision=revision+1 where id=$1',
      [organization.id],
    );
    for (const workspaceId of [
      organization.control_workspace_id,
      input.targetWorkspaceId,
    ])
      await recordFederationAudit(
        client,
        { ...input, workspaceId },
        {
          action: 'identity.workspace_unlinked',
          targetId: organization.id,
          metadata: { workspaceId: input.targetWorkspaceId },
        },
      );
    await withWorkspaceScope(client, input, (scoped) =>
      completeCommand(scoped, identity, { organizationId: organization.id }),
    );
  });
}
