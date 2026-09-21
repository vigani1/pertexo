import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { generatePersistedId } from '../platform/persisted-id.js';
import type {
  IdentityWorkspaceDatabase,
  RenameWorkspaceInput,
  WorkspaceRenameResult,
} from './identity-workspace-contracts.js';
import { WorkspaceRenameCommandConflictError } from './identity-workspace-errors.js';
import { mapWorkspace } from './identity-workspace-rows.js';
import { parseIdentityUuid } from './identity-workspace-support.js';
import { withTenantScopedClient } from './workspace.js';

type RenameStore = Pick<IdentityWorkspaceDatabase, 'renameWorkspace'>;
const nameSchema = z.string().trim().min(1).max(128);
const revisionSchema = z.number().int().positive();
const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
const durableResultSchema = z
  .object({
    workspace: z
      .object({
        id: z.uuid(),
        name: z.string().min(1).max(128),
        slug: z.string(),
        status: z.literal('active'),
        revision: revisionSchema,
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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commandHash(input: Readonly<Record<string, unknown>>): string {
  return hash(JSON.stringify(input, Object.keys(input).sort()));
}

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

function parsedResult(value: unknown): WorkspaceRenameResult | undefined {
  const result = durableResultSchema.safeParse(value);
  if (!result.success) return undefined;
  return Object.freeze({
    workspace: Object.freeze({
      ...result.data.workspace,
      createdAt: new Date(result.data.workspace.createdAt),
      updatedAt: new Date(result.data.workspace.updatedAt),
    }),
    changed: result.data.changed,
    replayed: true,
  });
}

async function claimReceipt(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    actorUserId: string;
    keyHash: string;
    requestHash: string;
  }>,
): Promise<Readonly<{ id: string }> | WorkspaceRenameResult> {
  const id = generatePersistedId();
  const inserted = await client.query(
    `insert into app.workspace_rename_command_receipts
       (id,workspace_id,actor_user_id,key_hash,request_hash,status)
     values($1,$2,$3,$4,$5,'in_progress')
     on conflict(actor_user_id,workspace_id,key_hash) do nothing`,
    [
      id,
      input.workspaceId,
      input.actorUserId,
      input.keyHash,
      input.requestHash,
    ],
  );
  if (inserted.rowCount === 1) return { id };
  const existing = await client.query<{
    request_hash: string;
    status: string;
    result_ref: unknown;
  }>(
    `select request_hash,status,result_ref
     from app.workspace_rename_command_receipts
     where actor_user_id=$1 and workspace_id=$2 and key_hash=$3 for update`,
    [input.actorUserId, input.workspaceId, input.keyHash],
  );
  const row = existing.rows[0];
  if (row?.request_hash !== input.requestHash)
    throw new WorkspaceRenameCommandConflictError(
      'idempotency_conflict',
      'The idempotency key belongs to another workspace rename',
    );
  const result = parsedResult(row.result_ref);
  if (row.status !== 'completed' || result === undefined)
    throw new Error('Workspace rename receipt is incomplete');
  return result;
}

export function createIdentityWorkspaceRenameStore(pool: Pool): RenameStore {
  return Object.freeze({
    renameWorkspace: async (raw: RenameWorkspaceInput) => {
      const workspaceId = parseIdentityUuid(raw.workspaceId);
      const actorUserId = parseIdentityUuid(raw.actorUserId);
      const name = nameSchema.parse(raw.name);
      const expectedRevision = revisionSchema.parse(raw.expectedRevision);
      const keyHash = hash(keySchema.parse(raw.idempotencyKey));
      const requestHash = commandHash({
        actorUserId,
        expectedRevision,
        name,
        workspaceId,
      });
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
          const receipt = await claimReceipt(client, {
            workspaceId,
            actorUserId,
            keyHash,
            requestHash,
          });
          if ('replayed' in receipt) return receipt;
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
          const completed = await client.query(
            `update app.workspace_rename_command_receipts
             set status='completed',result_ref=$2::jsonb,updated_at=clock_timestamp()
             where id=$1 and status='in_progress'`,
            [receipt.id, JSON.stringify(durableResult(result))],
          );
          if (completed.rowCount !== 1)
            throw new Error('Workspace rename receipt could not be completed');
          return result;
        },
      );
    },
  });
}
