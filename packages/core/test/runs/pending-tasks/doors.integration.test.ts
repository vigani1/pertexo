import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PendingTaskDecisionError } from '../../../src/runs/pending-tasks/responses/pending-task.errors.js';
import { WorkspaceAccessDeniedError } from '../../../src/shared/workspace-access.errors.js';
import { admin, store, taskFixture, userId } from './fixtures.js';

type Fixture = Awaited<ReturnType<typeof taskFixture>>;
type Status = 'active' | 'suspended' | 'pending_deletion';

const setWorkspaceStatus = (workspaceId: string, status: Status) =>
  admin.query(
    `update app.workspaces set status=$2::varchar,
        deletion_requested_at=case when $2::varchar='pending_deletion' then clock_timestamp() end,
        deletion_requested_by=case when $2::varchar='pending_deletion' then created_by end,
        deletion_reason=case when $2::varchar='pending_deletion' then 'test' end,
        purge_after=case when $2::varchar='pending_deletion' then clock_timestamp()+interval '30 days' end
      where id=$1`,
    [workspaceId, status],
  );

const taskRow = async ({ taskId }: Fixture) => {
  const { rows } = await admin.query<{
    status: string;
    decided_by: string | null;
  }>(`select status,decided_by from app.pending_run_tasks where id=$1`, [
    taskId,
  ]);
  return rows[0];
};

const decide = (f: Fixture, actorId = f.deciderId) =>
  store.decide({
    ...f.scope,
    actorId,
    decision: 'approved',
    idempotencyKey: randomUUID(),
  });

/** A member of the fixture's workspace, in this role. */
async function memberAs(f: Fixture, role: string) {
  const id = randomUUID();
  await admin.query(
    `insert into app.users(id,email,display_name) values($1,$2,'Member')`,
    [id, `${id}@example.test`],
  );
  await admin.query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')`,
    [f.workspaceId, id, role],
  );
  return id;
}

describe('which workspace statuses each door of a task opens on', () => {
  const scopeOf = (f: Fixture) => ({
    workspaceId: f.workspaceId,
    actorId: userId,
  });
  const AUDIENCE = { roles: ['owner'], memberIds: [] } as never;
  const READS = {
    list: (f: Fixture) =>
      store.list({ ...scopeOf(f), status: 'pending' } as never),
    read: (f: Fixture) => store.read(f.scope),
    audience: (f: Fixture) => store.audience({ ...scopeOf(f), q: '' }),
  };

  // A suspended workspace stays browsable, and pending work stays readable there.
  it.each(Object.keys(READS) as (keyof typeof READS)[])(
    '%s answers on active and suspended, and closes once deletion is scheduled',
    async (door) => {
      const f = await taskFixture();
      await expect(READS[door](f)).resolves.toBeDefined();

      await setWorkspaceStatus(f.workspaceId, 'suspended');
      await expect(READS[door](f)).resolves.toBeDefined();

      await setWorkspaceStatus(f.workspaceId, 'pending_deletion');
      await expect(READS[door](f)).rejects.toBeInstanceOf(
        WorkspaceAccessDeniedError,
      );
    },
  );

  it('shows the task itself on a suspended workspace, not just an answer', async () => {
    const f = await taskFixture();
    await setWorkspaceStatus(f.workspaceId, 'suspended');

    await expect(store.read(f.scope)).resolves.toMatchObject({
      id: f.taskId,
      status: 'pending',
    });
    const { items } = await store.list({
      workspaceId: f.workspaceId,
      actorId: f.deciderId,
      status: 'pending',
    } as never);
    expect(items.map(({ id }: { id: string }) => id)).toContain(f.taskId);
  });

  it('inspecting an audience, which an editor does, is for an active workspace only', async () => {
    const f = await taskFixture();
    const inspect = () =>
      store.inspectAudience({ ...scopeOf(f), audience: AUDIENCE });
    await expect(inspect()).resolves.toMatchObject({ matchingMemberCount: 1 });

    await setWorkspaceStatus(f.workspaceId, 'suspended');

    await expect(inspect()).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it.each(['suspended', 'pending_deletion'] as const)(
    'refuses a decision on a %s workspace, and the task stays pending',
    async (status) => {
      const f = await taskFixture();
      await setWorkspaceStatus(f.workspaceId, status);

      await expect(decide(f)).rejects.toBeInstanceOf(
        WorkspaceAccessDeniedError,
      );

      await expect(taskRow(f)).resolves.toMatchObject({
        status: 'pending',
        decided_by: null,
      });
    },
  );

  it('takes a decision again once a suspended workspace is back', async () => {
    const f = await taskFixture();
    await setWorkspaceStatus(f.workspaceId, 'suspended');
    await expect(decide(f)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);

    await setWorkspaceStatus(f.workspaceId, 'active');
    await decide(f);

    await expect(taskRow(f)).resolves.toMatchObject({
      status: 'approved',
      decided_by: f.deciderId,
    });
  });
});

describe('who a task’s doors open for', () => {
  const AUDIENCE = { roles: ['owner'], memberIds: [] } as never;

  it.each(['owner', 'admin', 'builder'])(
    'lets a %s look up who an approval could go to',
    async (role) => {
      const f = await taskFixture();
      const actorId = role === 'owner' ? userId : await memberAs(f, role);
      const scope = { workspaceId: f.workspaceId, actorId };

      await expect(store.audience({ ...scope, q: '' })).resolves.toBeDefined();
      await expect(
        store.inspectAudience({ ...scope, audience: AUDIENCE }),
      ).resolves.toBeDefined();
    },
  );

  // The workspace's directory isn't theirs to read because a task names them.
  it.each(['viewer', 'operator'])(
    'keeps the directory from a %s',
    async (role) => {
      const f = await taskFixture();
      const scope = {
        workspaceId: f.workspaceId,
        actorId: await memberAs(f, role),
      };

      await expect(store.audience({ ...scope, q: '' })).rejects.toBeInstanceOf(
        WorkspaceAccessDeniedError,
      );
      await expect(
        store.inspectAudience({ ...scope, audience: AUDIENCE }),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    },
  );

  it('answers someone from outside the workspace with a denial at every door', async () => {
    const f = await taskFixture();
    const outsider = randomUUID();
    await admin.query(
      `insert into app.users(id,email,display_name) values($1,$2,'Outsider')`,
      [outsider, `${outsider}@example.test`],
    );
    const scope = { workspaceId: f.workspaceId, actorId: outsider };

    for (const door of [
      () => store.list({ ...scope, status: 'pending' } as never),
      () => store.read({ ...f.scope, actorId: outsider }),
      () => store.audience({ ...scope, q: '' }),
      () => store.inspectAudience({ ...scope, audience: AUDIENCE }),
      () => decide(f, outsider),
    ])
      await expect(door()).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await expect(taskRow(f)).resolves.toMatchObject({ status: 'pending' });
  });

  it('stops a member who has left, at the moment they try', async () => {
    const f = await taskFixture();
    await admin.query(
      `update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2`,
      [f.workspaceId, f.deciderId],
    );

    await expect(store.read(f.scope)).rejects.toBeInstanceOf(
      WorkspaceAccessDeniedError,
    );
    await expect(decide(f)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
    await expect(taskRow(f)).resolves.toMatchObject({ status: 'pending' });
  });

  // Being a member gets you through the door. The task's own audience decides the rest.
  it('refuses a member the task doesn’t name, and leaves the task alone', async () => {
    const f = await taskFixture({ named: true });
    const other = await memberAs(f, 'viewer');

    await expect(decide(f, other)).rejects.toBeInstanceOf(
      PendingTaskDecisionError,
    );

    await expect(taskRow(f)).resolves.toMatchObject({ status: 'pending' });
    await decide(f);
    await expect(taskRow(f)).resolves.toMatchObject({ status: 'approved' });
  });
});

describe('the step name an approver reads', () => {
  const VERSION_GRAPH = (nodes: readonly unknown[]) =>
    JSON.stringify({ nodes, edges: [], settings: {} });

  /** A published version can't change, so only the seeding skips that rule. */
  const setGraph = async (f: Fixture, nodes: readonly unknown[]) => {
    await admin.query(`set session_replication_role=replica`);
    await admin.query(
      `update app.workflow_versions set graph_json=$2::jsonb where id=$1`,
      [f.parentVersionId, VERSION_GRAPH(nodes)],
    );
    await admin.query(`set session_replication_role=default`);
  };

  const nameRead = async (f: Fixture) => (await store.read(f.scope)).stepName;

  it('is the step’s label, on the task and in the list', async () => {
    const f = await taskFixture();
    await setGraph(f, [{ id: 'approval', label: 'Approve the invoice' }]);

    await expect(nameRead(f)).resolves.toBe('Approve the invoice');
    const { items } = await store.list({
      workspaceId: f.workspaceId,
      actorId: f.deciderId,
      status: 'pending',
    } as never);
    expect(
      (items as readonly { id: string; stepName: string | null }[]).find(
        ({ id }) => id === f.taskId,
      )?.stepName,
    ).toBe('Approve the invoice');
  });

  it('finds a step inside a For each, however deep', async () => {
    const f = await taskFixture();
    await setGraph(f, [
      { id: 'other', label: 'Something else' },
      {
        id: 'outer',
        label: 'Every order',
        structured: {
          body: {
            nodes: [
              {
                id: 'inner',
                label: 'Every line',
                structured: {
                  body: {
                    nodes: [{ id: 'approval', label: 'Approve a line' }],
                  },
                },
              },
            ],
          },
        },
      },
    ]);

    await expect(nameRead(f)).resolves.toBe('Approve a line');
  });

  it.each([
    ['blank', '   '],
    ['empty', ''],
  ])('is null for a %s label, not an empty title', async (_name, label) => {
    const f = await taskFixture();
    await setGraph(f, [{ id: 'approval', label }]);

    await expect(nameRead(f)).resolves.toBeNull();
  });

  it('is null for a step with no label', async () => {
    const f = await taskFixture();
    await setGraph(f, [{ id: 'approval' }]);

    await expect(nameRead(f)).resolves.toBeNull();
  });

  it('trims a label and keeps it to what the contract carries', async () => {
    const f = await taskFixture();
    await setGraph(f, [{ id: 'approval', label: `  ${'n'.repeat(300)} ` }]);

    await expect(nameRead(f)).resolves.toBe('n'.repeat(200));
  });

  // A test run's version isn't published, so there's no graph to read a name from.
  it('is null for a test run, whose version was never published', async () => {
    const f = await taskFixture();
    const unpublished = randomUUID();
    await admin.query(`set session_replication_role=replica`);
    await admin.query(
      `update app.workflow_runs set workflow_version_id=$2 where id=$1`,
      [f.parentRunId, unpublished],
    );
    await admin.query(
      `update app.pending_run_tasks set workflow_version_id=$2 where id=$1`,
      [f.taskId, unpublished],
    );
    await admin.query(`set session_replication_role=default`);

    await expect(nameRead(f)).resolves.toBeNull();
  });
});
