import {
  commandKeyHash,
  commandRequestHash,
} from '../shared/command-fingerprints.js';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { appendAuditFact } from '../governance/audit/facts.js';
import { eq } from 'drizzle-orm';
import { WorkspaceAccessDeniedError } from '../shared/workspace-access.errors.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import {
  generatePersistedId,
  acquireDatabasePool,
} from '@pertexo/database/platform';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
import { workspaces, users } from '@pertexo/database/schema';

import type {
  WorkspaceRecord,
  WorkspaceWithOwnerInput,
} from './tenant-access.types.js';
import { createIdentityWorkspaceInvitationAcceptanceStore } from './invitations/acceptance/identity-workspace-invitation-acceptance.store.js';
import { createIdentityWorkspaceInvitationStore } from './invitations/identity-workspace-invitation.store.js';
import { createIdentityWorkspaceMembershipLifecycleStore } from './members/membership-lifecycle.store.js';
import { createMemberships } from './members/records.repository.js';
import { createIdentityWorkspaceMemberRemovalStore } from './members/member-removal.store.js';
import { createIdentityWorkspaceMemberStore } from './members/workspace-members.store.js';
import { createIdentityWorkspaceRoleCommandStore } from './members/member-roles.store.js';
import { throwIdentityDatabaseConflict } from './conflicts.js';
import { createIdentityWorkspaceProfileStore } from './users/user-profile.store.js';
import { createUserStore } from './users/user.store.js';
import {
  claimWorkspaceCreationCommand,
  completeWorkspaceCreationCommand,
} from './workspaces/creation-receipt.repository.js';
import {
  workspaceRecord,
  workspaceSelection,
} from './workspaces/projection.js';
import { createIdentityWorkspaceRenameStore } from './workspaces/workspace-rename.store.js';

export type IdentityWorkspaceStore = ReturnType<
  typeof createIdentityWorkspaceStore
>;

export function createIdentityWorkspaceStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;

  return Object.freeze({
    ...createUserStore(pool),
    ...createIdentityWorkspaceMemberStore(pool),
    ...createIdentityWorkspaceRoleCommandStore(pool),
    ...createIdentityWorkspaceMemberRemovalStore(pool),
    ...createIdentityWorkspaceMembershipLifecycleStore(pool),
    ...createIdentityWorkspaceProfileStore(pool),
    ...createIdentityWorkspaceRenameStore(pool),
    ...createIdentityWorkspaceInvitationStore(pool),
    ...createIdentityWorkspaceInvitationAcceptanceStore(pool),

    createWorkspaceWithOwner: (input: WorkspaceWithOwnerInput) =>
      createWorkspaceWithOwner(pool, input),

    close: () => lease.close(),
  });
}

/** Off the helper: the workspace and its first member don't exist yet. */
async function createWorkspaceWithOwner(
  pool: Pool,
  input: WorkspaceWithOwnerInput,
): Promise<WorkspaceRecord> {
  const id = input.id ?? generatePersistedId();
  const ownerUserId = input.ownerUserId;
  const metadata = input.metadata ?? {};
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  const keyHash = commandKeyHash(input.idempotencyKey);
  const requestHash = commandRequestHash({
    actorId: ownerUserId,
    metadata,
    name,
    requestedWorkspaceId: input.id ?? null,
    slug,
  });
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: id, actorId: ownerUserId },
      async (client) => {
        const db = drizzle(client);
        const [owner] = await db
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, ownerUserId))
          .for('update')
          .catch(rethrowQueryFailure);
        if (owner?.status !== 'active')
          throw new WorkspaceAccessDeniedError(
            'Only an active user can create a workspace',
          );
        const claim = await claimWorkspaceCreationCommand(
          client,
          ownerUserId,
          keyHash,
          requestHash,
        );
        if (!claim.claimed) return claim.result.workspace;

        const workspaceResult = await db
          .insert(workspaces)
          .values({ id, name, slug, status: 'active', createdBy: ownerUserId })
          .returning(workspaceSelection)
          .catch(rethrowQueryFailure);
        await createMemberships(
          client,
          id,
          [
            {
              userId: ownerUserId,
              role: 'owner',
              source: 'workspace_creation',
            },
          ],
          {
            actorId: ownerUserId,
            requestId: input.requestId ?? null,
            traceId: input.traceId ?? null,
          },
        );
        await appendAuditFact(client, {
          workspaceId: id,
          actorId: ownerUserId,
          action: 'workspace.created',
          targetType: 'workspace',
          targetId: id,
          requestId: input.requestId ?? null,
          traceId: input.traceId ?? null,
          metadata: metadata,
        });
        const insertedWorkspace = workspaceResult[0];
        if (insertedWorkspace === undefined)
          throw new Error('Workspace creation returned no record');
        const workspace = workspaceRecord(insertedWorkspace);
        await completeWorkspaceCreationCommand(client, claim.id, {
          workspace,
        });
        return workspace;
      },
    );
  } catch (error: unknown) {
    throwIdentityDatabaseConflict(
      error,
      'Workspace creation conflicts with an existing record',
      'workspace_slug',
    );
  }
}
