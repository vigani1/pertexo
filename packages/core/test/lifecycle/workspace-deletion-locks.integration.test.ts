import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createIdentityWorkspaceRenameStore } from '../../src/tenant-access/workspaces/rename.repository.js';
import {
  afterAllFixture2,
  apiUrlFor as apiUrl,
  beforeAllFixture1,
  change,
  ownerUrlFor as ownerUrl,
} from './workspace-deletion/fixture.js';
import { newWorkspace, statusOf } from './workspace-deletion/workspaces.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

const DEADLOCK = '40P01';

/** A transaction that holds rows until told to let go. */
async function holding(statements: readonly (readonly [string, unknown[]])[]) {
  const pool = new Pool({ connectionString: ownerUrl(), max: 1 });
  const client = await pool.connect();
  await client.query('begin');
  for (const [text, values] of statements) await client.query(text, values);
  return {
    release: async () => {
      await client.query('commit');
      client.release();
      await pool.end();
    },
  };
}

const lockUser = (id: string) =>
  ['select 1 from app.users where id=$1 for update', [id]] as const;
const lockMembership = (workspace: string, user: string) =>
  [
    `select 1 from app.workspace_memberships
      where workspace_id=$1 and user_id=$2 for update`,
    [workspace, user],
  ] as const;

async function waitUntilBlocked(applicationName: string): Promise<void> {
  const monitor = new Pool({ connectionString: ownerUrl(), max: 1 });
  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const result = await monitor.query<{ blocked: boolean }>(
        `select exists (select 1 from pg_stat_activity
           where application_name=$1 and wait_event_type='Lock') blocked`,
        [applicationName],
      );
      if (result.rows[0]?.blocked === true) return;
      if (Date.now() > deadline)
        throw new Error(`${applicationName} never blocked`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await monitor.end();
  }
}

/** Whether another transaction can take this lock right now. */
async function canLock(text: string, values: readonly unknown[]) {
  const pool = new Pool({ connectionString: ownerUrl(), max: 1 });
  try {
    await pool.query(text, [...values]);
    return true;
  } catch (error: unknown) {
    if ((error as { code?: string }).code === '55P03') return false;
    throw error;
  } finally {
    await pool.end();
  }
}

function deletionPool() {
  const applicationName = `lifecycle-${randomUUID()}`;
  const url = new URL(apiUrl());
  url.searchParams.set('application_name', applicationName);
  return {
    applicationName,
    pool: new Pool({ connectionString: url.toString(), max: 1 }),
  };
}

describe('the deletion lock order', () => {
  it('takes the workspace row, then shares the user row, then the membership', async () => {
    const workspace = await newWorkspace();
    const { applicationName, pool } = deletionPool();
    const heldUser = await holding([lockUser(workspace.ownerId)]);
    const heldMembership = await holding([
      lockMembership(workspace.id, workspace.ownerId),
    ]);
    const workspaceRow =
      'select 1 from app.workspaces where id=$1 for update nowait';
    const userRow = (strength: string) =>
      `select 1 from app.users where id=$1 for ${strength} nowait`;
    try {
      const deletion = change(
        {
          commandType: 'deletion_requested',
          actorUserId: workspace.ownerId,
          workspaceId: workspace.id,
        },
        pool,
      );

      // Stopped at the user: it already holds the workspace row.
      await waitUntilBlocked(applicationName);
      expect(await canLock(workspaceRow, [workspace.id])).toBe(false);

      await heldUser.release();
      // Stopped at the membership: it holds the user row, but only shared.
      await waitUntilBlocked(applicationName);
      expect(await canLock(userRow('update'), [workspace.ownerId])).toBe(false);
      expect(await canLock(userRow('share'), [workspace.ownerId])).toBe(true);

      await heldMembership.release();
      await expect(deletion).resolves.toMatchObject({
        commandType: 'deletion_requested',
      });
    } finally {
      await pool.end();
    }
  });

  it('checks authority after the wait: an owner removed meanwhile is refused', async () => {
    const workspace = await newWorkspace();
    const { applicationName, pool } = deletionPool();
    const writer = await holding([
      ['select 1 from app.workspaces where id=$1 for update', [workspace.id]],
      [
        `update app.workspace_memberships set status='removed'
          where workspace_id=$1 and user_id=$2`,
        [workspace.id, workspace.ownerId],
      ],
    ]);
    try {
      const deletion = change(
        {
          commandType: 'deletion_requested',
          actorUserId: workspace.ownerId,
          workspaceId: workspace.id,
        },
        pool,
      );
      await waitUntilBlocked(applicationName);
      await writer.release();

      await expect(deletion).rejects.toMatchObject({
        reason: 'actor_inactive',
      });
      expect(await statusOf(workspace.id)).toBe('active');
    } finally {
      await pool.end();
    }
  });
});

describe('deletion racing other flows on the workspace', () => {
  it('two deletions finish with one change and no deadlock', async () => {
    for (let round = 0; round < 10; round += 1) {
      const workspace = await newWorkspace();
      const pool = new Pool({ connectionString: apiUrl(), max: 2 });
      try {
        const outcomes = await Promise.allSettled(
          [1, 2].map(() =>
            change(
              {
                commandType: 'deletion_requested',
                actorUserId: workspace.ownerId,
                workspaceId: workspace.id,
              },
              pool,
            ),
          ),
        );
        const refused = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
        );
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({ reason: 'invalid_state' });
      } finally {
        await pool.end();
      }
    }
  });

  it('a deletion and a rename both finish without a deadlock', async () => {
    for (let round = 0; round < 10; round += 1) {
      const workspace = await newWorkspace();
      const pool = new Pool({ connectionString: apiUrl(), max: 2 });
      const renames = createIdentityWorkspaceRenameStore(pool);
      try {
        const outcomes = await Promise.allSettled([
          change(
            {
              commandType: 'deletion_requested',
              actorUserId: workspace.ownerId,
              workspaceId: workspace.id,
            },
            pool,
          ),
          renames.renameWorkspace({
            workspaceId: workspace.id,
            actorUserId: workspace.ownerId,
            name: `Renamed ${String(round)}`,
            expectedRevision: 1,
            idempotencyKey: randomUUID(),
          }),
        ]);
        for (const outcome of outcomes)
          if (outcome.status === 'rejected')
            expect((outcome.reason as { code?: string }).code).not.toBe(
              DEADLOCK,
            );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(await statusOf(workspace.id)).toBe('pending_deletion');
      } finally {
        await pool.end();
      }
    }
  });

  it('a deletion and a role change of the owner both finish without a deadlock', async () => {
    for (let round = 0; round < 10; round += 1) {
      const workspace = await newWorkspace();
      const pool = new Pool({ connectionString: apiUrl(), max: 2 });
      const writer = new Pool({ connectionString: ownerUrl(), max: 1 });
      try {
        const outcomes = await Promise.allSettled([
          change(
            {
              commandType: 'deletion_requested',
              actorUserId: workspace.ownerId,
              workspaceId: workspace.id,
            },
            pool,
          ),
          writer.query(
            `with workspace as (
               select id from app.workspaces where id=$1 for share
             ), person as (
               select id from app.users where id=$2 for share
             )
             update app.workspace_memberships set role='admin'
              where workspace_id=$1 and user_id=$2`,
            [workspace.id, workspace.ownerId],
          ),
        ]);
        for (const outcome of outcomes)
          if (outcome.status === 'rejected')
            expect((outcome.reason as { code?: string }).code).not.toBe(
              DEADLOCK,
            );
      } finally {
        await writer.end();
        await pool.end();
      }
    }
  });
});
