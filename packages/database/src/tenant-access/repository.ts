import type { Pool } from 'pg';
import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';

import { z } from 'zod';
import type { DatabaseConfig } from '../config.js';

import { changeWorkspaceLifecycle } from '../lifecycle/deletion/repository.js';
import { mapWorkspace } from './rows.js';
import { createUserStore } from './users/repository.js';
import {
  parseIdentityMetadata,
  parseIdentityUuid,
  throwIdentityDatabaseConflict,
  throwWorkspaceLifecycleError,
} from './support.js';
import { withTenantScopedClient } from './transactions.js';
import { createIdentityWorkspaceMemberStore } from './members/repository.js';
import { createMemberships } from './members/records.repository.js';
import { createIdentityWorkspaceRoleCommandStore } from './members/roles.repository.js';
import { createIdentityWorkspaceMemberRemovalStore } from './members/removal.repository.js';
import { createIdentityWorkspaceMembershipLifecycleStore } from './members/lifecycle.repository.js';
import { createIdentityWorkspaceProfileStore } from './users/profile.repository.js';
import { createIdentityWorkspaceRenameStore } from './workspaces/rename.repository.js';
import { createIdentityWorkspaceInvitationStore } from './invitations/repository.js';
import { createIdentityWorkspaceInvitationAcceptanceStore } from './invitations/acceptance.repository.js';
import type {
  IdentityWorkspaceDatabase,
  RequestWorkspaceLifecycleOperationInput,
  WorkspaceLifecycleOperation,
  WorkspaceRecord,
  WorkspaceWithOwnerInput,
} from './contract.js';
import {
  commandRequestHash,
  commandKeyHash,
  claimWorkspaceCreationCommand,
  completeWorkspaceCreationCommand,
} from './workspaces/creation-receipt.repository.js';
export type { Role, DelegatedRole } from '@pertexo/workflow-model';
export {
  IdentityConflictError,
  IdentityNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspaceLifecycleConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  WorkspaceMembershipCommandConflictError,
  WorkspaceRenameCommandConflictError,
  WorkspaceInvitationCommandConflictError,
  InvitationAcceptanceConflictError,
  UserProfileCommandConflictError,
  type IdentityConflictReason,
  type WorkspaceLifecycleConflictReason,
  type WorkspaceMemberRoleCommandConflictReason,
  type WorkspaceMemberRemovalCommandConflictReason,
  type WorkspaceMembershipCommandConflictReason,
  type WorkspaceRenameCommandConflictReason,
} from './errors.js';
export {
  USER_STATUS,
  WORKSPACE_STATUS,
  type AccessibleWorkspaceRecord,
  type AccessibleWorkspacesPage,
  type ChangeWorkspaceMemberRoleInput,
  type CreateUserInput,
  type IdentityWorkspaceDatabase,
  type RequestWorkspaceLifecycleOperationInput,
  type UserRecord,
  type UserStatus,
  type WorkspaceAccessRecord,
  type WorkspaceLifecycleOperation,
  type WorkspaceMemberRecord,
  type WorkspaceMemberRoleChangeResult,
  type RemoveWorkspaceMemberInput,
  type WorkspaceMemberRemovalResult,
  type LeaveWorkspaceInput,
  type WorkspaceMemberStatusCommandInput,
  type WorkspaceMemberStatusResult,
  type TransferWorkspaceOwnershipInput,
  type WorkspaceOwnershipTransferResult,
  type UpdateUserProfileInput,
  type UserProfileUpdateResult,
  type ChangeWorkspaceInvitationInput,
  type CreateWorkspaceInvitationInput,
  type SealedInvitationToken,
  type WorkspaceInvitationCommandResult,
  type WorkspaceInvitationRecord,
  type WorkspaceInvitationsPage,
  type CompleteInvitationAcceptanceInput,
  type InvitationAcceptanceIntentRecord,
  type InvitationAcceptanceResult,
  type ResolveInvitationAcceptanceInput,
  type WorkspaceMembersPage,
  type WorkspaceRecord,
  type WorkspaceStatus,
  type WorkspaceWithOwnerInput,
  type RenameWorkspaceInput,
  type WorkspaceRenameResult,
} from './contract.js';

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
  const id = parseIdentityUuid(input.id ?? generatePersistedId());
  const ownerUserId = parseIdentityUuid(input.ownerUserId);
  const metadata = parseIdentityMetadata(input.metadata);
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (name.length === 0 || name.length > 128)
    throw new Error('Invalid workspace name');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    throw new Error('Invalid workspace slug');
  }
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

        const workspaceResult = await client.query(
          `insert into app.workspaces (id, name, slug, status, created_by)
             values ($1, $2, $3, 'active', $4)
             returning id, name, slug, status, revision, created_by,
                       deletion_requested_at, deletion_requested_by, deletion_reason,
                       purge_after,
                       created_at, updated_at`,
          [id, name, slug, ownerUserId],
        );
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
        await client.query(
          `insert into app.audit_events
               (id, workspace_id, actor_user_id, action, target_type, target_id,
                request_id, trace_id, metadata)
             values ($1, $2, $3, 'workspace.created', 'workspace', $2, $4, $5, $6::jsonb)`,
          [
            generatePersistedId(),
            id,
            ownerUserId,
            input.requestId ?? null,
            input.traceId ?? null,
            JSON.stringify(metadata),
          ],
        );
        const workspace = mapWorkspace(
          workspaceResult.rows[0] as Record<string, unknown>,
        );
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
  const workspaceId = parseIdentityUuid(input.workspaceId);
  const actorUserId = parseIdentityUuid(input.actorUserId);
  const commandType = z
    .enum(['deletion_requested', 'deletion_restored'])
    .parse(input.commandType);
  const reason = z.string().trim().min(1).max(512).parse(input.reason);
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
