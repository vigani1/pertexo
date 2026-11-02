import { randomBytes, randomUUID } from 'node:crypto';

import { admin } from '../../../lifecycle/calls/fixtures.js';
import type { fixture } from './fixture.js';
import { store } from './fixture.js';

export type Form = Awaited<ReturnType<typeof fixture>>;

export const newCapability = () => randomBytes(32).toString('base64url');

export async function openPublicly(f: Form) {
  const capability = newCapability();
  const access = await store.setAccess({
    ...f,
    access: 'public',
    expectedRevision: 0,
    capability,
    idempotencyKey: `enable-${capability}`,
  });
  if (access.publicId === null) throw new Error('Public identity missing');
  const grant = await store.discover({ publicId: access.publicId, capability });
  return { capability, grant, publicId: access.publicId, access };
}

export const runs = async ({ workflowId }: Form) =>
  (
    await admin.query<{ count: number }>(
      'select count(*)::int count from app.workflow_runs where workflow_id=$1',
      [workflowId],
    )
  ).rows[0]?.count;

export const response = (f: Form, idempotencyKey: string = randomUUID()) => ({
  workspaceId: f.workspaceId,
  workflowId: f.workflowId,
  versionId: f.versionId,
  values: { amount: 1 },
  idempotencyKey,
});

export const closeWorkspace = {
  suspended: ({ workspaceId }: Form) =>
    admin.query("update app.workspaces set status='suspended' where id=$1", [
      workspaceId,
    ]),
  pending_deletion: ({ workspaceId, actorId }: Form) =>
    admin.query(
      `update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp(),
         deletion_requested_by=$2,deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
       where id=$1`,
      [workspaceId, actorId],
    ),
};

/** A pause has to name the run behind it, so this leaves one more run than it found. */
export const PAUSE_STATEMENT = `update app.workflows
    set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
        trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
        trigger_pause_last_run_id=(select id from app.workflow_runs where workflow_id=$1 limit 1),
        trigger_pause_revision=trigger_pause_revision+1
  where id=$1`;

export async function addMember(f: Form, role: string) {
  const id = randomUUID();
  await admin.query(
    `insert into app.users(id,email,display_name) values($1,$2,'Form member')`,
    [id, `${id}@example.test`],
  );
  await admin.query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')`,
    [f.workspaceId, id, role],
  );
  return id;
}
