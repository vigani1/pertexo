import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdempotencyRequestConflictError } from '../../src/runs/commands/acceptance/errors.js';

import {
  afterAllFixture2,
  asOwner,
  beforeAllFixture1,
  change,
  connectionId,
  ownerUserId,
  scheduleTriggerId,
  workflowId,
  workspaceId,
} from './workspace-deletion/fixture.js';

// Widened by the reactivation change; `never` keeps this typed before and after.
const REACTIVATED = 'reactivated' as never;

const members = {
  admin: randomUUID(),
  builder: randomUUID(),
  operator: randomUUID(),
  viewer: randomUUID(),
} as const;

const WORKSPACE_STATES = {
  active: `status='active', deletion_requested_at=null,
    deletion_requested_by=null, deletion_reason=null, purge_after=null`,
  suspended: `status='suspended', deletion_requested_at=null,
    deletion_requested_by=null, deletion_reason=null, purge_after=null`,
  pending_deletion: `status='pending_deletion',
    deletion_requested_at=clock_timestamp(), deletion_requested_by=created_by,
    deletion_reason='Closing the workspace',
    purge_after=clock_timestamp()+interval '30 days'`,
  purging: `status='purging', deletion_requested_at=clock_timestamp(),
    deletion_requested_by=created_by, deletion_reason='Closing the workspace',
    purge_after=clock_timestamp()+interval '30 days'`,
  deleted: `status='deleted', deletion_requested_at=clock_timestamp(),
    created_by=null, deletion_requested_by=null, deletion_reason='purged',
    purge_after=clock_timestamp()+interval '30 days',
    name='Deleted workspace', slug='deleted-'||id`,
} as const;

/** The tables deletion stopped: ADR 013 step 3 leaves them off until re-enabled. */
const STOPPED_BY_DELETION = [
  'api_tokens',
  'connections',
  'failure_notification_destinations',
  'trigger_schedules',
  'webhook_trigger_endpoints',
  'workflow_triggers',
  'workflows',
  'workspace_invitations',
] as const;

async function putWorkspaceIn(
  status: keyof typeof WORKSPACE_STATES,
): Promise<void> {
  await asOwner(
    `update app.workspaces set ${WORKSPACE_STATES[status]} where id=$1`,
    [workspaceId],
  );
}

async function workspaceStatus(): Promise<string | undefined> {
  const { rows } = await asOwner(
    'select status from app.workspaces where id=$1',
    [workspaceId],
  );
  return (rows as readonly { status: string }[])[0]?.status;
}

async function reactivationAudits(): Promise<readonly unknown[]> {
  const { rows } = await asOwner(
    `select actor_user_id, target_type, target_id from app.audit_events
     where workspace_id=$1 and action='workspace.reactivated'`,
    [workspaceId],
  );
  return rows as readonly unknown[];
}

async function stoppedRows(): Promise<unknown> {
  const columns = STOPPED_BY_DELETION.map(
    (table) => `'${table}', (
      select coalesce(jsonb_agg(to_jsonb(entry) order by to_jsonb(entry)::text),'[]'::jsonb)
      from app.${table} entry where entry.workspace_id=$1)`,
  ).join(',');
  const { rows } = await asOwner(
    `select jsonb_build_object(${columns}) stopped`,
    [workspaceId],
  );
  return (rows as readonly { stopped: unknown }[])[0]?.stopped;
}

async function deleteAndRestore(): Promise<void> {
  await putWorkspaceIn('active');
  await change({ commandType: 'deletion_requested' });
  await change({ commandType: 'deletion_restored' });
}

beforeAll(async () => {
  await beforeAllFixture1();
  for (const [role, userId] of Object.entries(members)) {
    await asOwner(
      `insert into app.users(id,email,display_name) values($1,$2,$3)`,
      [userId, `${userId}@example.test`, role],
    );
    await asOwner(
      `insert into app.workspace_memberships(workspace_id,user_id,role)
       values($1,$2,$3)`,
      [workspaceId, userId, role],
    );
  }
}, 120_000);
afterAll(afterAllFixture2);

describe('reactivating a suspended workspace', () => {
  // audit-1030 follow-up 1: nothing can lift a restore's `suspended` today.
  it.fails('makes it active, with one audit row and a receipt', async () => {
    await deleteAndRestore();

    const receipt = await change({ commandType: REACTIVATED });

    expect(receipt).toMatchObject({ workspaceId, commandType: 'reactivated' });
    const { rows } = await asOwner(
      `select status, deletion_requested_at, deletion_requested_by,
         deletion_reason, purge_after
       from app.workspaces where id=$1`,
      [workspaceId],
    );
    expect(rows[0]).toEqual({
      status: 'active',
      deletion_requested_at: null,
      deletion_requested_by: null,
      deletion_reason: null,
      purge_after: null,
    });
    expect(await reactivationAudits()).toEqual([
      {
        actor_user_id: ownerUserId,
        target_type: 'workspace',
        target_id: workspaceId,
      },
    ]);
  });

  // audit-1030 follow-up 1: a retried request must replay, not hit its refusal.
  it.fails('replays a retry with the same key', async () => {
    await deleteAndRestore();
    const auditsBefore = (await reactivationAudits()).length;
    const idempotencyKeyHash = 'b'.repeat(64);

    const receipt = await change({
      commandType: REACTIVATED,
      idempotencyKeyHash,
    });

    await expect(
      change({ commandType: REACTIVATED, idempotencyKeyHash }),
    ).resolves.toEqual(receipt);
    expect(await reactivationAudits()).toHaveLength(auditsBefore + 1);
    await expect(
      change({
        commandType: REACTIVATED,
        idempotencyKeyHash,
        requestHash: '2'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    await expect(
      change({ commandType: 'deletion_requested', idempotencyKeyHash }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });

  // audit-1030 follow-up 1: ADR 013 step 3 keeps these off until re-enabled.
  it.fails('changes only the workspace status', async () => {
    await deleteAndRestore();
    await asOwner(
      `insert into app.auth_sessions(id,user_id,token,expires_at)
       values($1,$2,$3,clock_timestamp()+interval '1 day')`,
      [randomUUID(), ownerUserId, randomUUID()],
    );
    const before = await stoppedRows();

    await change({ commandType: REACTIVATED });

    expect(await workspaceStatus()).toBe('active');
    expect(await stoppedRows()).toEqual(before);
    const { rows } = await asOwner(
      `select
        (select status from app.connections where id=$2) connection_status,
        (select status from app.trigger_schedules where trigger_id=$3) schedule_status,
        (select bool_and(status='disabled') from app.workflow_triggers
          where workspace_id=$1) triggers_disabled,
        (select activation_status from app.workflows where id=$4) workflow_status,
        (select count(*)::int from app.auth_sessions where user_id=$5) sessions`,
      [workspaceId, connectionId, scheduleTriggerId, workflowId, ownerUserId],
    );
    expect(rows[0]).toEqual({
      connection_status: 'reauthorization_required',
      schedule_status: 'disabled',
      triggers_disabled: true,
      workflow_status: 'inactive',
      sessions: 1,
    });
  });

  it.each(['admin', 'builder', 'operator', 'viewer'] as const)(
    'refuses a member who is %s',
    async (role) => {
      await putWorkspaceIn('suspended');

      await expect(
        change({ commandType: REACTIVATED, actorUserId: members[role] }),
      ).rejects.toMatchObject({ reason: 'actor_inactive' });

      expect(await workspaceStatus()).toBe('suspended');
    },
  );

  // audit-1030 follow-up 1: only Restore may leave `pending_deletion`.
  it.fails('refuses a workspace scheduled for deletion', async () => {
    await putWorkspaceIn('pending_deletion');

    await expect(change({ commandType: REACTIVATED })).rejects.toMatchObject({
      reason: 'invalid_state',
    });

    expect(await workspaceStatus()).toBe('pending_deletion');
  });

  it.each(['active', 'purging', 'deleted'] as const)(
    'refuses a workspace that is %s',
    async (status) => {
      await putWorkspaceIn(status);
      const auditsBefore = (await reactivationAudits()).length;

      await expect(change({ commandType: REACTIVATED })).rejects.toMatchObject({
        reason: 'invalid_state',
      });

      expect(await workspaceStatus()).toBe(status);
      expect(await reactivationAudits()).toHaveLength(auditsBefore);
    },
  );
});
