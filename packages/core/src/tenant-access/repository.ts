import {
  appendAuditFact,
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
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
import { workspaces } from '@pertexo/database/schema';

import { changeWorkspaceLifecycle } from '../lifecycle/deletion/repository.js';
import type {
  IdentityWorkspaceDatabase,
  RequestWorkspaceLifecycleOperationInput,
  WorkspaceLifecycleOperation,
  WorkspaceRecord,
  WorkspaceWithOwnerInput,
} from './contract.js';
import { createIdentityWorkspaceInvitationAcceptanceStore } from './invitations/acceptance.repository.js';
import { createIdentityWorkspaceInvitationStore } from './invitations/repository.js';
import { createIdentityWorkspaceMembershipLifecycleStore } from './members/lifecycle.repository.js';
import { createMemberships } from './members/records.repository.js';
import { createIdentityWorkspaceMemberRemovalStore } from './members/removal.repository.js';
import { createIdentityWorkspaceMemberStore } from './members/repository.js';
import { createIdentityWorkspaceRoleCommandStore } from './members/roles.repository.js';
import {
  throwIdentityDatabaseConflict,
  throwWorkspaceLifecycleError,
} from './support.js';
import { createIdentityWorkspaceProfileStore } from './users/profile.repository.js';
import { createUserStore } from './users/repository.js';
import {
  claimWorkspaceCreationCommand,
  commandKeyHash,
  commandRequestHash,
  completeWorkspaceCreationCommand,
} from './workspaces/creation-receipt.repository.js';
import {
  workspaceRecord,
  workspaceSelection,
} from './workspaces/projection.js';
import { createIdentityWorkspaceRenameStore } from './workspaces/rename.repository.js';

export function createIdentityWorkspaceDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): IdentityWorkspaceDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;

  const database = {
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

    requestWorkspaceLifecycleOperation: (
      input: RequestWorkspaceLifecycleOperationInput,
    ) => requestWorkspaceLifecycleOperation(pool, input),

    close: () => lease.close(),
  } satisfies IdentityWorkspaceDatabase;

  return Object.freeze(database);
}

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
        const claim = await claimWorkspaceCreationCommand(
          client,
          ownerUserId,
          keyHash,
          requestHash,
        );
        if (!claim.claimed) return claim.result.workspace;

        const db = drizzle(client);
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

async function requestWorkspaceLifecycleOperation(
  pool: Pool,
  input: RequestWorkspaceLifecycleOperationInput,
): Promise<WorkspaceLifecycleOperation> {
  const workspaceId = input.workspaceId;
  const actorUserId = input.actorUserId;
  const commandType = input.commandType;
  const reason = input.reason;
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId, actorId: actorUserId },
      (client) =>
        changeWorkspaceLifecycle(client, {
          operationId: generatePersistedId(),
          workspaceId,
          actorUserId,
          commandType,
          reason,
          idempotencyKeyHash: commandKeyHash(input.idempotencyKey),
          requestHash: commandRequestHash({
            actorUserId,
            commandType,
            reason,
            workspaceId,
          }),
        }),
    );
  } catch (error: unknown) {
    throwWorkspaceLifecycleError(error);
  }
}
