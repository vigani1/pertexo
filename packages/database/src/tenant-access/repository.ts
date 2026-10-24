import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaces, auditEvents } from '../schema/foundation.js';
import { rethrowQueryFailure } from '../platform/query-errors.js';
import type { Pool } from 'pg';
import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';
import { generatePersistedId } from '../platform/persisted-id.js';

import { z } from 'zod';
import type { DatabaseConfig } from '../config.js';

import { changeWorkspaceLifecycle } from '../lifecycle/deletion/repository.js';
import {
  workspaceRecord,
  workspaceSelection,
} from './workspaces/projection.js';
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
        await db
          .insert(auditEvents)
          .values({
            id: generatePersistedId(),
            workspaceId: id,
            actorUserId: ownerUserId,
            action: 'workspace.created',
            targetType: 'workspace',
            targetId: id,
            requestId: input.requestId ?? null,
            traceId: input.traceId ?? null,
            metadata: sql`${JSON.stringify(metadata)}::jsonb`,
          })
          .catch(rethrowQueryFailure);
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
