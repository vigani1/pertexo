import { COLLABORATION_LIMITS } from '@pertexo/workflow-model';
import { rolesForCapability } from '@pertexo/workflow-model';
import type { WorkflowPresence } from '@pertexo/contracts';
import type { PoolClient } from 'pg';
import { requireCollaborationAuthority } from './authority.queries.js';
import {
  WorkflowCollaborationError,
  type CollaborationContext,
  type CollaborationScope,
  type WorkflowCollaborationStore,
} from './contract.js';
async function readPresence(
  client: PoolClient,
  input: CollaborationScope & { tabId: string },
): Promise<WorkflowPresence> {
  const result = await client.query<{
    user_id: string;
    display_name: string;
    editing: boolean;
    dirty: boolean;
    base_revision: number | null;
    tab_count: number;
  }>(
    `select lease.user_id,actor.display_name,bool_or(lease.editing and member.role=any($6::varchar[])) editing,bool_or(lease.dirty and member.role=any($6::varchar[])) dirty,min(lease.base_revision) base_revision,count(*)::integer tab_count from app.workflow_presence_leases lease join app.workspace_memberships member on member.workspace_id=lease.workspace_id and member.user_id=lease.user_id and member.status='active' join app.users actor on actor.id=member.user_id and actor.status='active' where lease.workspace_id=$1 and lease.workflow_id=$2 and lease.expires_at>clock_timestamp() and not(lease.user_id=$3 and lease.tab_id=$4) group by lease.user_id,actor.display_name order by bool_or(lease.dirty and member.role=any($6::varchar[])) desc,bool_or(lease.editing and member.role=any($6::varchar[])) desc,actor.display_name,lease.user_id limit $5`,
    [
      input.workspaceId,
      input.workflowId,
      input.actorId,
      input.tabId,
      COLLABORATION_LIMITS.presence,
      rolesForCapability('workflow:update'),
    ],
  );
  return {
    people: result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      editing: row.editing,
      dirty: row.dirty,
      baseRevision: row.base_revision,
      tabCount: row.tab_count,
    })),
  };
}
export function collaborationPresence(
  context: CollaborationContext,
): Pick<WorkflowCollaborationStore, 'presence' | 'heartbeat' | 'leave'> {
  return {
    presence: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input);
          return readPresence(client, input);
        },
        input.signal,
      ),
    heartbeat: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input, 'update', {
            editing: input.editing,
          });
          await client.query(
            'delete from app.workflow_presence_leases where workspace_id=$1 and workflow_id=$2 and expires_at<=clock_timestamp()',
            [input.workspaceId, input.workflowId],
          );
          const existing = await client.query(
            'select sequence from app.workflow_presence_leases where workspace_id=$1 and workflow_id=$2 and user_id=$3 and tab_id=$4',
            [input.workspaceId, input.workflowId, input.actorId, input.tabId],
          );
          if (existing.rowCount === 0) {
            const counts = (
              await client.query<{ total: number; own: number }>(
                'select count(*)::integer total,count(*) filter(where user_id=$3)::integer own from app.workflow_presence_leases where workspace_id=$1 and workflow_id=$2',
                [input.workspaceId, input.workflowId, input.actorId],
              )
            ).rows[0];
            if (counts === undefined)
              throw new Error('Presence counts missing');
            if (
              counts.total >= COLLABORATION_LIMITS.presence ||
              counts.own >= COLLABORATION_LIMITS.tabs
            )
              throw new WorkflowCollaborationError(
                'limit',
                'Presence is full for this workflow. You can still edit and save normally.',
              );
          }
          const stored = await client.query(
            `insert into app.workflow_presence_leases as lease(workspace_id,workflow_id,user_id,tab_id,sequence,editing,dirty,base_revision,last_seen_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),clock_timestamp()+$9*interval '1 second') on conflict(workspace_id,workflow_id,user_id,tab_id) do update set sequence=excluded.sequence,editing=excluded.editing,dirty=excluded.dirty,base_revision=excluded.base_revision,last_seen_at=excluded.last_seen_at,expires_at=excluded.expires_at where lease.sequence<excluded.sequence`,
            [
              input.workspaceId,
              input.workflowId,
              input.actorId,
              input.tabId,
              input.sequence,
              input.editing,
              input.dirty,
              input.baseRevision,
              COLLABORATION_LIMITS.leaseSeconds,
            ],
          );
          return { accepted: stored.rowCount === 1 };
        },
        input.signal,
      ),
    leave: (input) =>
      context.transact(
        input.workspaceId,
        input.actorId,
        async (client) => {
          await requireCollaborationAuthority(client, input);
          await client.query(
            'delete from app.workflow_presence_leases where workspace_id=$1 and workflow_id=$2 and user_id=$3 and tab_id=$4',
            [input.workspaceId, input.workflowId, input.actorId, input.tabId],
          );
        },
        input.signal,
      ),
  };
}
