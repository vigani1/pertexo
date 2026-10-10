import type { Pool } from 'pg';
import { z } from 'zod';

import {
  claimCommand,
  completeCommand,
  type CommandIdentity,
} from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { commandKeySchema, commandRevisionSchema } from '../command-keys.js';
import type {
  IdentityWorkspaceDatabase,
  RenameWorkspaceInput,
  WorkspaceRenameResult,
} from '../contracts.js';
import { WorkspaceRenameCommandConflictError } from '../errors.js';
import { mapWorkspace } from '../rows.js';
import { parseIdentityUuid } from '../support.js';
import { withTenantScopedClient } from '../transactions.js';

type RenameStore = Pick<IdentityWorkspaceDatabase, 'renameWorkspace'>;
const nameSchema = z.string().trim().min(1).max(128);
const durableResultSchema = z
  .object({
    workspace: z
      .object({
        id: z.uuid(),
        name: z.string().min(1).max(128),
        slug: z.string(),
        status: z.literal('active'),
        revision: commandRevisionSchema,
        createdBy: z.uuid(),
        deletionRequestedAt: z.null(),
        deletionRequestedBy: z.null(),
        deletionReason: z.null(),
        purgeAfter: z.null(),
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
    changed: z.boolean(),
  })
  .strict();

function durableResult(result: WorkspaceRenameResult) {
  return durableResultSchema.parse({
    workspace: {
      ...result.workspace,
      createdAt: result.workspace.createdAt.toISOString(),
      updatedAt: result.workspace.updatedAt.toISOString(),
    },
    changed: result.changed,
  });
}

function replayedResult(value: unknown): WorkspaceRenameResult {
  const { workspace, changed } = durableResultSchema.parse(value);
  return Object.freeze({
    workspace: Object.freeze({
      ...workspace,
      createdAt: new Date(workspace.createdAt),
      updatedAt: new Date(workspace.updatedAt),
    }),
    changed,
    replayed: true,
  });
}

export function createIdentityWorkspaceRenameStore(pool: Pool): RenameStore {
  return Object.freeze({
    renameWorkspace: async (raw: RenameWorkspaceInput) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const actorUserId = parseIdentityUuid(raw.actorUserId);
      const name = nameSchema.parse(raw.name);
      const expectedRevision = commandRevisionSchema.parse(
        raw.expectedRevision,
      );
      const key: CommandIdentity = {
        workspaceId,
        operation: 'workspace.rename',
        scope: actorUserId,
        idempotencyKey: commandKeySchema.parse(raw.idempotencyKey),
      };
      return withTenantScopedClient(
        pool,
        { workspaceId, actorId: actorUserId },
        async (client): Promise<WorkspaceRenameResult> => {
          const workspace = await client.query(
            `select id,name,slug,status,revision,created_by,
                    deletion_requested_at,deletion_requested_by,deletion_reason,
                    purge_after,created_at,updated_at
             from app.workspaces where id=$1 for update`,
            [workspaceId],
          );
          const current = workspace.rows[0] as
            Record<string, unknown> | undefined;
          if (current?.status !== 'active')
            throw new WorkspaceRenameCommandConflictError(
              'workspace_inactive',
              'Only active workspaces can be renamed',
            );
          await client.query(
            'select id from app.users where id=$1 for update',
            [actorUserId],
          );
          const access = await client.query<{
            role: string;
            membership_status: string;
            user_status: string;
          }>(
            `select membership.role,membership.status membership_status,
                    actor.status user_status
             from app.workspace_memberships membership
             join app.users actor on actor.id=membership.user_id
             where membership.workspace_id=$1 and membership.user_id=$2
             for update of membership,actor`,
            [workspaceId, actorUserId],
          );
          const actor = access.rows[0];
          if (
            actor?.membership_status !== 'active' ||
            actor.user_status !== 'active' ||
            (actor.role !== 'owner' && actor.role !== 'admin')
          )
            throw new WorkspaceRenameCommandConflictError(
              'actor_inactive',
              'The actor cannot manage this workspace',
            );
          const stored = await claimCommand(client, {
            ...key,
            request: { name, expectedRevision },
            resourceId: workspaceId,
          });
          if (stored !== null) return replayedResult(stored);
          const currentWorkspace = mapWorkspace(current);
          if (currentWorkspace.revision !== expectedRevision)
            throw new WorkspaceRenameCommandConflictError(
              'revision_conflict',
              'The workspace changed since it was loaded',
            );
          const changed = currentWorkspace.name !== name;
          let renamed = currentWorkspace;
          if (changed) {
            const updated = await client.query(
              `update app.workspaces
               set name=$2,revision=revision+1,updated_at=clock_timestamp()
               where id=$1
               returning id,name,slug,status,revision,created_by,
                         deletion_requested_at,deletion_requested_by,deletion_reason,
                         purge_after,created_at,updated_at`,
              [workspaceId, name],
            );
            renamed = mapWorkspace(updated.rows[0] as Record<string, unknown>);
            await client.query(
              `insert into app.audit_events
                 (id,workspace_id,actor_user_id,action,target_type,target_id,
                  request_id,trace_id,metadata)
               values($1,$2,$3,'workspace.renamed','workspace',$2,$4,$5,$6::jsonb)`,
              [
                generatePersistedId(),
                workspaceId,
                actorUserId,
                raw.requestId ?? null,
                raw.traceId ?? null,
                JSON.stringify({
                  fromName: currentWorkspace.name,
                  toName: renamed.name,
                  fromRevision: currentWorkspace.revision,
                  toRevision: renamed.revision,
                }),
              ],
            );
          }
          const result = Object.freeze({
            workspace: renamed,
            changed,
            replayed: false,
          });
          await completeCommand(client, key, durableResult(result));
          return result;
        },
      );
    },
  });
}
