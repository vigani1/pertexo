import { authOrganizationWorkspaces } from '@pertexo/database/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import { removeDirectoryFolderGrants } from '../../../../tenant-access/resources/revocation.repository.js';
import type { Pool } from 'pg';
import {
  generatePersistedId,
  withPlatformTransaction,
} from '@pertexo/database/platform';
import {
  lockWorkspaceAuthority,
  lockWorkspaceRow,
} from '../../../../shared/authority.queries.js';
import {
  organizationForWorkspace,
  recordFederationAudit,
} from '../../management/authority.repository.js';
import { advanceOrganization } from '../../management/commands.repository.js';
import {
  lockDirectoryOrganization,
  lockDirectoryParticipants,
} from '../authority.repository.js';
import { DirectoryError } from '../errors.js';
import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';
import type { UnlinkWorkspaceInput } from '../contract.js';
import { detachDirectoryMemberships } from './detach.repository.js';

/**
 * Doesn't fit `withWorkspaceAccess`, for the reasons `runDirectoryCommand` gives:
 * the same locks come before authority, and its audit facts span two workspaces.
 */
export async function unlinkDirectoryWorkspace(
  pool: Pool,
  input: UnlinkWorkspaceInput,
): Promise<void> {
  await withPlatformTransaction(pool, async (client) => {
    // The workspace remains the command's receipt authority even after unlinking.
    // Lock the receipt workspace before deciding whether the old link still exists.
    const preview = await organizationForWorkspace(client, input.workspaceId);
    if (preview === undefined)
      await lockWorkspaceRow(client, input.workspaceId);
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
    await drizzle(client)
      .delete(authOrganizationWorkspaces)
      .where(
        and(
          eq(authOrganizationWorkspaces.organizationId, organization.id),
          eq(authOrganizationWorkspaces.workspaceId, input.targetWorkspaceId),
        ),
      )
      .catch(rethrowQueryFailure);
    await advanceOrganization(client, organization);
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
