import { randomUUID } from 'node:crypto';

import { asOwner } from './fixture.js';

export const COMMANDS = [
  'deletion_requested',
  'deletion_restored',
  'reactivated',
] as const;

export type Status =
  'active' | 'suspended' | 'pending_deletion' | 'purging' | 'deleted';

const STATES: Readonly<Record<Status, string>> = {
  active: `status='active', deletion_requested_at=null,
    deletion_requested_by=null, deletion_reason=null, purge_after=null`,
  suspended: `status='suspended', deletion_requested_at=null,
    deletion_requested_by=null, deletion_reason=null, purge_after=null`,
  pending_deletion: `status='pending_deletion',
    deletion_requested_at=clock_timestamp(),
    deletion_requested_by=coalesce(deletion_requested_by,created_by),
    deletion_reason='Closing the workspace',
    purge_after=clock_timestamp()+interval '30 days'`,
  purging: `status='purging', deletion_requested_at=clock_timestamp(),
    deletion_requested_by=coalesce(deletion_requested_by,created_by),
    deletion_reason='Closing the workspace',
    purge_after=clock_timestamp()+interval '30 days'`,
  deleted: `status='deleted', deletion_requested_at=clock_timestamp(),
    created_by=null, deletion_requested_by=null, deletion_reason='purged',
    purge_after=clock_timestamp()+interval '30 days',
    name='Deleted workspace', slug='deleted-'||id`,
};

export async function putWorkspaceIn(
  workspaceId: string,
  status: Status,
): Promise<void> {
  await asOwner(`update app.workspaces set ${STATES[status]} where id=$1`, [
    workspaceId,
  ]);
}

export async function statusOf(workspaceId: string): Promise<string> {
  const result = await asOwner(
    'select status from app.workspaces where id=$1',
    [workspaceId],
  );
  return String(result.rows[0]?.status);
}

/** Receipts written for the workspace: one per change that took effect. */
export async function lifecycleWrites(workspaceId: string): Promise<number> {
  const result = await asOwner(
    `select count(*)::int "count" from app.workspace_lifecycle_operations
      where workspace_id=$1`,
    [workspaceId],
  );
  return Number(result.rows[0]?.count);
}

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await asOwner(
    `insert into app.users(id,email,display_name) values($1,$2,'Person')`,
    [id, `${id}@example.test`],
  );
  return id;
}

export async function newWorkspace() {
  const id = randomUUID();
  const ownerId = await insertUser();
  await asOwner(
    `insert into app.workspaces(id,name,slug,created_by)
     values($1,'Lifecycle',$2,$3)`,
    [id, `lifecycle-${id}`, ownerId],
  );
  await asOwner(
    `insert into app.workspace_memberships(workspace_id,user_id,role)
     values($1,$2,'owner')`,
    [id, ownerId],
  );
  return {
    id,
    ownerId,
    addMember: async (role: string): Promise<string> => {
      const userId = await insertUser();
      await asOwner(
        `insert into app.workspace_memberships(workspace_id,user_id,role)
         values($1,$2,$3)`,
        [id, userId, role],
      );
      return userId;
    },
    /** Leaves someone who looks like the owner without the authority. */
    disqualify: async (
      kind:
        | 'outsider'
        | 'owner_suspended'
        | 'membership_suspended'
        | 'membership_removed',
    ): Promise<string> => {
      if (kind === 'outsider') return insertUser();
      if (kind === 'owner_suspended')
        await asOwner(`update app.users set status='suspended' where id=$1`, [
          ownerId,
        ]);
      else
        await asOwner(
          `update app.workspace_memberships set status=$3
            where workspace_id=$1 and user_id=$2`,
          [
            id,
            ownerId,
            kind === 'membership_suspended' ? 'suspended' : 'removed',
          ],
        );
      return ownerId;
    },
    /** The recovery period starts at the request, so both move together. */
    passRecoveryPeriod: async (): Promise<void> => {
      await asOwner(
        `update app.workspaces
            set deletion_requested_at=clock_timestamp()-interval '31 days',
                purge_after=clock_timestamp()-interval '1 day'
          where id=$1`,
        [id],
      );
    },
  };
}
