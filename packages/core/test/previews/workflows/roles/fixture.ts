import { randomUUID } from 'node:crypto';

import type { Role } from '@pertexo/workflow-model';

import {
  queryAsOwner,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import {
  command as suiteCommand,
  database,
  fixture as suiteFixture,
  query,
} from '../../suites/progress/fixture.js';

export { query };

type Uuid = ReturnType<typeof randomUUID>;

export type WorkspaceStatus = 'active' | 'suspended' | 'pending_deletion';

/** A person who reaches the workspace with this role, in the seeded workspace. */
export async function member(role: Role): Promise<Uuid> {
  const id = randomUUID();
  await queryAsOwner(
    "insert into app.users(id,email,display_name,status) values($1,$2,'Member','active')",
    [id, `member-${id}@example.test`],
  );
  await query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
    [workspaceId, id, role],
  );
  return id;
}

/** Someone with an account and no membership here. */
export async function outsider(): Promise<string> {
  const id = randomUUID();
  await queryAsOwner(
    "insert into app.users(id,email,display_name,status) values($1,$2,'Outsider','active')",
    [id, `outsider-${id}@example.test`],
  );
  return id;
}

export const setMembershipStatus = (userId: string, status: string) =>
  query(
    'update app.workspace_memberships set status=$3 where workspace_id=$1 and user_id=$2',
    [workspaceId, userId, status],
  );

export const setUserStatus = (userId: string, status: string) =>
  queryAsOwner('update app.users set status=$2 where id=$1', [userId, status]);

export const setRole = (userId: string, role: Role) =>
  query(
    'update app.workspace_memberships set role=$3 where workspace_id=$1 and user_id=$2',
    [workspaceId, userId, role],
  );

export const setWorkspaceStatus = (status: WorkspaceStatus) =>
  query(
    `update app.workspaces set status=$2::text,
       deletion_requested_at=case when $3 then clock_timestamp() end,
       deletion_requested_by=case when $3 then created_by end,
       deletion_reason=case when $3 then 'state proof' end,
       purge_after=case when $3 then clock_timestamp()+interval '7 days' end
     where id=$1`,
    [workspaceId, status, status === 'pending_deletion'],
  );

/** A draft with input cases, ready to test or suite, as `actorId` left it. */
export async function draft(cases = 2) {
  return suiteFixture(cases);
}

type Draft = Awaited<ReturnType<typeof draft>>;

export async function startTest(f: Draft, actorId: string) {
  const scope = { ...f.scope, actorId };
  const preparation = await database.workflowTests.prepare(scope);
  const { runId } = await database.workflowTests.start({
    ...scope,
    idempotencyKey: randomUUID(),
    request: {
      expectedRevision: preparation.draftRevision,
      expectedSamples: preparation.samples,
      expectedEffectfulSteps: preparation.effectfulSteps.map(
        (step) => step.nodeId,
      ),
      input: { amount: 1 },
      acknowledgeSideEffects: false,
    },
  });
  return { scope, runId };
}

export async function startSuite(f: Draft, actorId: Uuid) {
  const scope = { ...f.scope, actorId };
  const intent = await suiteCommand({ ...f, scope });
  const { suiteId } = await database.workflowTestSuites.start(intent);
  return { scope, suiteId };
}

export async function runState(runId: string) {
  const [row] = await query<{
    status: string;
    cancel_requested_at: Date | null;
  }>('select status,cancel_requested_at from app.workflow_runs where id=$1', [
    runId,
  ]);
  if (row === undefined) throw new Error('Run is missing');
  return row;
}

export async function suiteState(suiteId: string) {
  const [row] = await query<{
    status: string;
    cancel_requested: boolean;
    stop_reason: string | null;
  }>(
    'select status,cancel_requested,stop_reason from app.workflow_test_suites where id=$1',
    [suiteId],
  );
  if (row === undefined) throw new Error('Suite is missing');
  return row;
}
