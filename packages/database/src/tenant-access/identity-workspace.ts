import { createHash, randomUUID } from 'node:crypto';
import { acquireDatabasePool } from '../platform/database-runtime.js';
import type { DatabaseRuntime } from '../platform/database-runtime.js';

import { generatePersistedId } from '../platform/persisted-id.js';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../config.js';
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
} from './identity-workspace-errors.js';
import {
  IDEMPOTENCY_STATUS,
  IdempotencyRecordCorruptError,
  IdempotencyRequestConflictError,
} from '../execution/execution-acceptance.js';
import {
  mapWorkspace,
  mapWorkspaceLifecycleOperation,
  workspaceLifecycleOperationRowSelection,
} from './identity-workspace-rows.js';
import { createIdentityWorkspaceSessionStore } from './identity-workspace-session-store.js';
import { createIdentityWorkspaceIdentityStore } from './identity-workspace-identity-store.js';
import {
  parseIdentityMetadata,
  parseIdentityUuid,
  throwIdentityDatabaseConflict,
  throwWorkspaceLifecycleError,
} from './identity-workspace-support.js';
import { withTenantScopedClient } from './workspace.js';
import { createIdentityWorkspaceMemberStore } from './identity-workspace-member-store.js';
import { createIdentityWorkspaceRoleCommandStore } from './identity-workspace-role-command.js';
import { createIdentityWorkspaceMemberRemovalStore } from './identity-workspace-member-removal.js';
import { createIdentityWorkspaceMembershipLifecycleStore } from './identity-workspace-membership-lifecycle.js';
import { createIdentityWorkspaceProfileStore } from './identity-workspace-profile-store.js';
import { createIdentityWorkspaceRenameStore } from './identity-workspace-rename-store.js';
import { createIdentityWorkspaceInvitationStore } from './identity-workspace-invitation-store.js';
import { createIdentityWorkspaceInvitationAcceptanceStore } from './identity-workspace-invitation-acceptance-store.js';

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));

import {
  WORKSPACE_STATUS,
  type IdentityWorkspaceDatabase,
  type RequestWorkspaceLifecycleOperationInput,
  type WorkspaceCreationResult as PublicWorkspaceCreationResult,
  type WorkspaceLifecycleOperation,
  type WorkspaceRecord,
  type WorkspaceWithOwnerInput,
} from './identity-workspace-contracts.js';
export {
  MEMBERSHIP_ROLE,
  USER_STATUS,
  WORKSPACE_STATUS,
  type AuthIdentityRecord,
  type AccessibleWorkspaceRecord,
  type AccessibleWorkspacesPage,
  type CreateAuthIdentityInput,
  type ChangeWorkspaceMemberRoleInput,
  type CreateSessionInput,
  type CreateUserInput,
  type IdentityWorkspaceDatabase,
  type MembershipRole,
  type RequestWorkspaceLifecycleOperationInput,
  type ResolveOrCreateIdentityInput,
  type ResolvedIdentity,
  type SessionRecord,
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
  type DelegatedMembershipRole,
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
} from './identity-workspace-contracts.js';

type WorkspaceCreationResult = PublicWorkspaceCreationResult;

// This is the historical idempotency snapshot for workspace creation, not a
// general workspace-row codec. A newly created workspace cannot be `purging`.
// revokedSessionCount remains required so existing result_ref values retain
// their original shape even though the public create method returns workspace.
const durableWorkspaceResultSchema = z
  .object({
    workspace: z
      .object({
        id: z.uuid(),
        name: z.string(),
        slug: z.string(),
        status: z.enum([
          WORKSPACE_STATUS.active,
          WORKSPACE_STATUS.suspended,
          WORKSPACE_STATUS.pendingDeletion,
          WORKSPACE_STATUS.deleted,
        ]),
        createdBy: z.uuid(),
        deletionRequestedAt: z.iso.datetime().nullable(),
        deletionRequestedBy: z.uuid().nullable(),
        deletionReason: z.string().nullable(),
        purgeAfter: z.iso.datetime().nullable(),
        revision: z.number().int().positive().default(1),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
    revokedSessionCount: z.number().int().nonnegative(),
  })
  .strict();

function durableWorkspaceResult(
  workspace: WorkspaceRecord,
  revokedSessionCount: number,
): z.output<typeof durableWorkspaceResultSchema> {
  return durableWorkspaceResultSchema.parse({
    workspace: {
      ...workspace,
      deletionRequestedAt: workspace.deletionRequestedAt?.toISOString() ?? null,
      purgeAfter: workspace.purgeAfter?.toISOString() ?? null,
      revision: workspace.revision,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    },
    revokedSessionCount,
  });
}

function parseDurableWorkspaceResult(value: unknown): WorkspaceCreationResult {
  const result = durableWorkspaceResultSchema.safeParse(value);
  if (!result.success) throw new IdempotencyRecordCorruptError();
  const workspace = result.data.workspace;
  return Object.freeze({
    workspace: Object.freeze({
      ...workspace,
      deletionRequestedAt:
        workspace.deletionRequestedAt === null
          ? null
          : new Date(workspace.deletionRequestedAt),
      purgeAfter:
        workspace.purgeAfter === null ? null : new Date(workspace.purgeAfter),
      createdAt: new Date(workspace.createdAt),
      updatedAt: new Date(workspace.updatedAt),
    }),
    revokedSessionCount: result.data.revokedSessionCount,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commandRequestHash(value: Record<string, unknown>): string {
  return sha256(canonicalJson(value));
}

function commandKeyHash(value: string | undefined): string {
  return sha256(idempotencyKeySchema.parse(value ?? randomUUID()));
}

type CommandClaim =
  | Readonly<{ claimed: true; id: string }>
  | Readonly<{ claimed: false; result: WorkspaceCreationResult }>;

async function claimWorkspaceCreationCommand(
  client: PoolClient,
  actorUserId: string,
  keyHash: string,
  requestHash: string,
): Promise<CommandClaim> {
  const operation = 'workspace.create';
  const inserted = await client.query<{ id: string }>(
    `insert into app.workspace_creation_idempotency_records
       (id, actor_user_id, operation, key_hash, request_hash, status)
     values ($1, $2, $3, $4, $5, 'in_progress')
     on conflict (actor_user_id, operation, key_hash) do nothing
     returning id`,
    [generatePersistedId(), actorUserId, operation, keyHash, requestHash],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId !== undefined) return { claimed: true, id: insertedId };

  const existing = await client.query<{
    request_hash: string;
    result_ref: unknown;
    status: string;
  }>(
    `select request_hash, status, result_ref
     from app.workspace_creation_idempotency_records
     where actor_user_id = $1 and operation = $2 and key_hash = $3`,
    [actorUserId, operation, keyHash],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new IdempotencyRecordCorruptError();
  if (row.request_hash !== requestHash) {
    throw new IdempotencyRequestConflictError();
  }
  if (row.status !== IDEMPOTENCY_STATUS.completed) {
    throw new IdempotencyRecordCorruptError();
  }
  return {
    claimed: false,
    result: parseDurableWorkspaceResult(row.result_ref),
  };
}

async function completeWorkspaceCreationCommand(
  client: PoolClient,
  claimId: string,
  result: WorkspaceCreationResult,
): Promise<void> {
  const completed = await client.query(
    `update app.workspace_creation_idempotency_records
     set status = 'completed', resource_id = $2, result_ref = $3::jsonb,
         updated_at = clock_timestamp()
     where id = $1 and status = 'in_progress'`,
    [
      claimId,
      result.workspace.id,
      JSON.stringify(
        durableWorkspaceResult(result.workspace, result.revokedSessionCount),
      ),
    ],
  );
  if (completed.rowCount !== 1) throw new IdempotencyRecordCorruptError();
}

export function createIdentityWorkspaceDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): IdentityWorkspaceDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;

  const database = {
    ...createIdentityWorkspaceIdentityStore(pool),
    ...createIdentityWorkspaceMemberStore(pool),
    ...createIdentityWorkspaceRoleCommandStore(pool),
    ...createIdentityWorkspaceMemberRemovalStore(pool),
    ...createIdentityWorkspaceMembershipLifecycleStore(pool),
    ...createIdentityWorkspaceProfileStore(pool),
    ...createIdentityWorkspaceRenameStore(pool),
    ...createIdentityWorkspaceInvitationStore(pool),
    ...createIdentityWorkspaceInvitationAcceptanceStore(pool),

    ...createIdentityWorkspaceSessionStore(pool),

    createWorkspaceWithOwner: async (
      input: WorkspaceWithOwnerInput,
    ): Promise<WorkspaceRecord> => {
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
            await client.query(
              `insert into app.workspace_memberships
               (workspace_id, user_id, role, status)
             values ($1, $2, 'owner', 'active')`,
              [id, ownerUserId],
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
              revokedSessionCount: 0,
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
    },

    requestWorkspaceLifecycleOperation: async (
      input: RequestWorkspaceLifecycleOperationInput,
    ): Promise<WorkspaceLifecycleOperation> => {
      const workspaceId = parseIdentityUuid(input.workspaceId);
      const actorUserId = parseIdentityUuid(input.actorUserId);
      const commandType = z
        .enum(['deletion_requested', 'deletion_restored'])
        .parse(input.commandType);
      const reason = z.string().trim().min(1).max(512).parse(input.reason);
      const idempotencyKeyHash = commandKeyHash(input.idempotencyKey);
      const requestHash = commandRequestHash({
        actorUserId,
        commandType,
        reason,
        workspaceId,
      });
      try {
        return await withTenantScopedClient(
          pool,
          { workspaceId, actorId: actorUserId },
          async (client) => {
            const result = await client.query(
              `select ${workspaceLifecycleOperationRowSelection} from
                 app.request_workspace_lifecycle_operation($1::uuid,$2::uuid,
                   $3::char(64),$4::varchar,$5::uuid,$6::varchar,$7::char(64))`,
              [
                generatePersistedId(),
                workspaceId,
                idempotencyKeyHash,
                commandType,
                actorUserId,
                reason,
                requestHash,
              ],
            );
            const row = result.rows[0] as Record<string, unknown> | undefined;
            if (result.rowCount !== 1 || row === undefined) {
              throw new Error('Workspace lifecycle operation was not returned');
            }
            return mapWorkspaceLifecycleOperation(row);
          },
        );
      } catch (error: unknown) {
        throwWorkspaceLifecycleError(error);
      }
    },

    readWorkspaceLifecycleOperation: async (
      workspaceIdInput: string,
      operationIdInput: string,
      actorUserIdInput: string,
    ): Promise<WorkspaceLifecycleOperation | null> => {
      const workspaceId = parseIdentityUuid(workspaceIdInput);
      const operationId = parseIdentityUuid(operationIdInput);
      const actorUserId = parseIdentityUuid(actorUserIdInput);
      try {
        return await withTenantScopedClient(
          pool,
          { workspaceId, actorId: actorUserId },
          async (client) => {
            const result = await client.query(
              `select ${workspaceLifecycleOperationRowSelection} from
                 app.read_workspace_lifecycle_operation($1::uuid,$2::uuid,$3::uuid)`,
              [workspaceId, operationId, actorUserId],
            );
            const row = result.rows[0] as Record<string, unknown> | undefined;
            return row === undefined
              ? null
              : mapWorkspaceLifecycleOperation(row);
          },
        );
      } catch (error: unknown) {
        throwWorkspaceLifecycleError(error);
      }
    },

    close: () => lease.close(),
  } satisfies IdentityWorkspaceDatabase;

  return Object.freeze(database);
}
