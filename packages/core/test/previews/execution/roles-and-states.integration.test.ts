import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PreviewAdmissionDeniedError } from '../../../src/previews/errors.js';
import {
  actorId,
  afterAllFixture2,
  apiPreviews,
  beforeAllFixture1,
  digest,
  disposableDatabase,
  input,
  keyHash,
  ownerWorkspaceQuery,
  requestHash,
  resetFixture,
  workflowA,
  workspaceA,
} from './fixture.js';

beforeAll(beforeAllFixture1);
beforeEach(resetFixture);
afterAll(afterAllFixture2);

const adminUrl = () =>
  disposableDatabase.databaseUrl(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );

async function asAdmin<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return (await client.query<Row>(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function person(status = 'active'): Promise<string> {
  const id = randomUUID();
  await asAdmin(
    "insert into app.users(id,email,display_name,status) values($1,$2,'Person',$3)",
    [id, `${id}@example.test`, status],
  );
  return id;
}

async function member(
  role: string,
  { membership = 'active', user = 'active' } = {},
): Promise<string> {
  const id = await person(user);
  await ownerWorkspaceQuery(
    workspaceA,
    'insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,$4)',
    [workspaceA, id, role, membership],
  );
  return id;
}

const previewCount = async () => {
  const [row] = await asAdmin<{ count: string }>(
    'select count(*) from app.preview_runs where workspace_id=$1',
    [workspaceA],
  );
  return Number(row?.count);
};

const accept = (actorUserId: string) =>
  apiPreviews.acceptPreview({
    workspaceId: workspaceA,
    ...input({
      actorUserId,
      scope: `${actorUserId}:${workflowA}`,
      keyHash: digest(randomUUID()),
      requestHash: digest(randomUUID()),
    }),
  });

const flows = (previewRunId: string) =>
  [
    ['accept', (actor: string) => accept(actor)],
    [
      'read',
      (actor: string) =>
        apiPreviews.readPreview({
          workspaceId: workspaceA,
          actorUserId: actor,
          previewRunId,
        }),
    ],
    [
      'replay',
      (actor: string) =>
        apiPreviews.resolvePreviewReplay({
          workspaceId: workspaceA,
          actorUserId: actor,
          workflowId: workflowA,
          keyHash,
          requestHash,
        }),
    ],
  ] as const;

const firstPreview = () =>
  apiPreviews.acceptPreview({ workspaceId: workspaceA, ...input() });

const setStatus = (status: string) =>
  asAdmin(
    `update app.workspaces set status=$2::text,
       deletion_requested_at=case when $3 then clock_timestamp() end,
       deletion_requested_by=case when $3 then created_by end,
       deletion_reason=case when $3 then 'state proof' end,
       purge_after=case when $3 then clock_timestamp()+interval '7 days' end
     where id=$1`,
    [workspaceA, status, status === 'pending_deletion'],
  );

describe('who can test a step', () => {
  it('refuses everyone without edit rights, for accept, read and replay, and writes nothing', async () => {
    const { previewRunId } = await firstPreview();
    const denied: readonly (readonly [string, string])[] = [
      ['a viewer', await member('viewer')],
      ['an operator', await member('operator')],
      ['an outsider', await person()],
      ['a deactivated user', await member('builder', { user: 'suspended' })],
      [
        'a suspended member',
        await member('builder', { membership: 'suspended' }),
      ],
    ];
    const before = await previewCount();

    for (const [flow, run] of flows(previewRunId))
      for (const [who, id] of denied)
        await expect(run(id), `${who}: ${flow}`).rejects.toMatchObject({
          name: 'PreviewAdmissionDeniedError',
          message: 'preview.actor_denied',
        });

    expect(await previewCount()).toBe(before);
  });

  it('lets an owner, an admin and a builder do all three', async () => {
    const { previewRunId } = await firstPreview();
    for (const role of ['owner', 'admin', 'builder']) {
      const id =
        role === 'owner'
          ? await asAdmin(
              "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
              [workspaceA, actorId],
            ).then(() => actorId)
          : await member(role);
      for (const [flow, run] of flows(previewRunId))
        await expect(run(id), `${role}: ${flow}`).resolves.toBeDefined();
    }
  });

  it('keeps a builder outside a restricted folder from accepting, and shows them nothing', async () => {
    const { previewRunId } = await firstPreview();
    const outside = await member('builder');
    const folderId = randomUUID();
    await ownerWorkspaceQuery(
      workspaceA,
      "insert into app.workflow_folders(id,workspace_id,name,name_key,access_mode) values($1,$2,'Private','private','restricted')",
      [folderId, workspaceA],
    );
    await ownerWorkspaceQuery(
      workspaceA,
      'insert into app.workflow_organization_state(workflow_id,folder_id,workspace_id) values($1,$2,$3) on conflict (workspace_id,workflow_id) do update set folder_id=$2',
      [workflowA, folderId, workspaceA],
    );
    const before = await previewCount();
    const [, read, replay] = flows(previewRunId);

    await expect(accept(outside)).rejects.toMatchObject({
      message: 'preview.draft_denied',
    });
    await expect(read[1](outside)).resolves.toBeNull();
    await expect(replay[1](outside)).resolves.toBeNull();
    expect(await previewCount()).toBe(before);
  });
});

describe('what each workspace state allows', () => {
  it.each(['suspended', 'pending_deletion'])(
    'refuses accept, read and replay while %s, reads included',
    async (status) => {
      const { previewRunId } = await firstPreview();
      const before = await previewCount();
      await setStatus(status);

      for (const [flow, run] of flows(previewRunId))
        await expect(run(actorId), flow).rejects.toMatchObject({
          name: 'PreviewAdmissionDeniedError',
          message: 'preview.actor_denied',
        });

      expect(await previewCount()).toBe(before);
    },
  );
});

describe('when authority changes while an accept is waiting', () => {
  /** Holds a row, runs `waiting` up to the lock, changes the row, and lets go. */
  async function underHeldRow(
    lockSql: string,
    values: unknown[],
    change: string,
  ) {
    const holder = new Client({ connectionString: adminUrl() });
    await holder.connect();
    const monitor = new Client({ connectionString: adminUrl() });
    await monitor.connect();
    try {
      await holder.query('begin');
      await holder.query(lockSql, values);
      const accepting = accept(actorId).then(
        () => 'accepted',
        (error: unknown) =>
          error instanceof PreviewAdmissionDeniedError ? 'denied' : error,
      );
      await expect
        .poll(
          async () =>
            (
              await monitor.query<{ count: number }>(
                `select count(*)::int as count from pg_stat_activity
                 where datname=current_database() and wait_event_type='Lock'`,
              )
            ).rows[0]?.count,
          { timeout: 10_000, interval: 25 },
        )
        .toBe(1);
      await holder.query(change, values);
      await holder.query('commit');
      return await accepting;
    } finally {
      await Promise.all([holder.end(), monitor.end()]);
    }
  }

  it('refuses a member removed while the accept waited', async () => {
    const before = await previewCount();
    await expect(
      underHeldRow(
        'select 1 from app.workspace_memberships where workspace_id=$1 and user_id=$2 for update',
        [workspaceA, actorId],
        'delete from app.workspace_memberships where workspace_id=$1 and user_id=$2',
      ),
    ).resolves.toBe('denied');
    expect(await previewCount()).toBe(before);
  });

  it('refuses a member demoted while the accept waited', async () => {
    const before = await previewCount();
    await expect(
      underHeldRow(
        'select 1 from app.workspace_memberships where workspace_id=$1 and user_id=$2 for update',
        [workspaceA, actorId],
        "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
      ),
    ).resolves.toBe('denied');
    expect(await previewCount()).toBe(before);
  });

  it("can't commit past a deletion of the workspace", async () => {
    const before = await previewCount();
    await expect(
      underHeldRow(
        'select 1 from app.workspaces where id=$1 for update',
        [workspaceA],
        `update app.workspaces set status='pending_deletion',
           deletion_requested_at=clock_timestamp(),deletion_requested_by=created_by,
           deletion_reason='race proof',purge_after=clock_timestamp()+interval '7 days'
         where id=$1`,
      ),
    ).resolves.toBe('denied');
    expect(await previewCount()).toBe(before);
  });
});
