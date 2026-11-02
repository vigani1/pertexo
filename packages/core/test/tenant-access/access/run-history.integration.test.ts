import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withRetainedRunRead } from '../../../src/runs/queries/access.queries.js';
import {
  admin,
  adminDatabaseUrl,
  closeWorld,
  identities,
  join,
  openWorld,
  person,
  pool,
  postgresCode,
  restrict,
  runs,
  seedRun,
  setMembership,
  setStatus,
  setUserStatus,
  team,
  workspaceOwnedBy,
  type WorkspaceStatus,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

type Reader = Readonly<{ workspaceId: string; actorId: string }>;

/** Everything run history answers, as one person sees it. */
async function historyAs(reader: Reader, runId: string, workflowId: string) {
  const [page, statistics, run, readable, input, health] = await Promise.all([
    runs.list({ ...reader, limit: 10 }),
    runs.statistics({ ...reader, window: '24h', includeWorkflows: true }),
    runs.get({ ...reader, runId }),
    runs.canRead({ ...reader, runId }),
    runs.readInput({ ...reader, runId }),
    runs.stepHealth({ ...reader, workflowId, window: '24h' }),
  ]);
  return { page, statistics, run, readable, input, health };
}

function expectNothing(history: Awaited<ReturnType<typeof historyAs>>) {
  expect(history.page.items).toEqual([]);
  expect(history.page.nextCursor).toBeUndefined();
  expect(history.statistics.window.total).toBe(0);
  expect(Object.values(history.statistics.window.byStatus)).toEqual(
    Object.values(history.statistics.window.byStatus).map(() => 0),
  );
  expect(history.statistics.workflows?.items).toEqual([]);
  expect(history.run).toBeUndefined();
  expect(history.readable).toBe(false);
  expect(history.input).toBeUndefined();
  expect(history.health).toBeUndefined();
}

function expectTheRun(
  history: Awaited<ReturnType<typeof historyAs>>,
  runId: string,
) {
  expect(history.page.items.map(({ id }) => id)).toEqual([runId]);
  expect(history.statistics.window.total).toBe(1);
  expect(history.run?.run.id).toBe(runId);
  expect(history.readable).toBe(true);
}

describe('run history for someone with no access', () => {
  const outsiders: readonly (readonly [
    string,
    (workspaceId: string) => Promise<string>,
  ])[] = [
    [
      'a member of another workspace only',
      async () => {
        const stranger = await person();
        await workspaceOwnedBy(stranger);
        return stranger;
      },
    ],
    ['someone who belongs nowhere', () => person()],
    [
      'a removed member',
      async (workspaceId) => {
        const member = await join(workspaceId, 'admin');
        await setMembership(workspaceId, member, 'removed');
        return member;
      },
    ],
    [
      'a suspended member',
      async (workspaceId) => {
        const member = await join(workspaceId, 'admin');
        await setMembership(workspaceId, member, 'suspended');
        return member;
      },
    ],
    [
      'a deactivated user',
      async (workspaceId) => {
        const member = await join(workspaceId, 'admin');
        await setUserStatus(member, 'suspended');
        return member;
      },
    ],
  ];

  it.each(outsiders)(
    '%s reads an empty page, zero counts and no run, never a denial',
    async (_who, makeOutsider) => {
      const { workspaceId, owner } = await team();
      const { runId, workflowId } = await seedRun(workspaceId, owner);
      const actorId = await makeOutsider(workspaceId);
      expectNothing(await historyAs({ workspaceId, actorId }, runId, workflowId));
    },
  );

  it('answers a run in another workspace, asked for through your own, with nothing', async () => {
    const mine = await team();
    const theirs = await team();
    const { runId, workflowId } = await seedRun(
      theirs.workspaceId,
      theirs.owner,
    );
    expectNothing(
      await historyAs(
        { workspaceId: mine.workspaceId, actorId: mine.owner },
        runId,
        workflowId,
      ),
    );
  });
});

describe('run history as a workspace leaves service', () => {
  it.each<WorkspaceStatus>(['active', 'suspended', 'pending_deletion'])(
    'answers a member on %s',
    async (status) => {
      const { workspaceId, owner, viewer } = await team();
      const { runId, workflowId } = await seedRun(workspaceId, owner);
      await setStatus(workspaceId, status);
      expectTheRun(
        await historyAs({ workspaceId, actorId: viewer }, runId, workflowId),
        runId,
      );
    },
  );

  it.each<WorkspaceStatus>(['purging', 'deleted'])(
    'reads as an outsider on %s, even for its owner',
    async (status) => {
      const { workspaceId, owner } = await team();
      const { runId, workflowId } = await seedRun(workspaceId, owner);
      await setStatus(workspaceId, status);
      expectNothing(
        await historyAs({ workspaceId, actorId: owner }, runId, workflowId),
      );
    },
  );
});

describe('run history limited by folder', () => {
  it('shows a builder only permitted runs, in the same page and counts', async () => {
    const { workspaceId, owner, builder } = await team();
    const hidden = await seedRun(workspaceId, owner);
    const shown = await seedRun(workspaceId, owner);
    await restrict(workspaceId, hidden.workflowId);

    const page = await runs.list({ workspaceId, actorId: builder, limit: 1 });
    expect(page.items.map(({ id }) => id)).toEqual([shown.runId]);
    expect(page.nextCursor).toBeUndefined();
    const statistics = await runs.statistics({
      workspaceId,
      actorId: builder,
      window: '24h',
    });
    expect(statistics.window.total).toBe(1);

    // The owner is not limited: the same rows are there.
    const full = await runs.list({ workspaceId, actorId: owner, limit: 10 });
    expect(full.items.map(({ id }) => id).sort()).toEqual(
      [hidden.runId, shown.runId].sort(),
    );
  });
});

describe('what the read still bounds', () => {
  it('gives up on statistics at their timeout rather than holding a connection', async () => {
    const { workspaceId, owner } = await team();
    await seedRun(workspaceId, owner);
    const blocker = await admin.connect();
    try {
      await blocker.query('begin');
      await blocker.query('lock table app.workflow_runs in access exclusive mode');
      const started = Date.now();
      const failure = await runs
        .statistics({ workspaceId, actorId: owner, window: '24h' })
        .then(
          () => 'answered',
          (error: unknown) => postgresCode(error),
        );
      expect(failure).toBe('57014');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  }, 30_000);

  it('stops at a signal already aborted', async () => {
    const { workspaceId, owner } = await team();
    await expect(
      runs.list({
        workspaceId,
        actorId: owner,
        limit: 1,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels a read in progress at the signal', async () => {
    const { workspaceId, owner } = await team();
    const controller = new AbortController();
    await expect(
      withRetainedRunRead(
        pool,
        { workspaceId, actorId: owner, signal: controller.signal },
        async (transaction) => {
          const sleeping = transaction.db.execute('select pg_sleep(30)');
          controller.abort();
          return sleeping;
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  }, 30_000);

  it('takes no timeout or other option from fields a body could add to the actor', async () => {
    const { workspaceId, owner } = await team();
    const body = {
      workspaceId,
      actorId: owner,
      statementTimeoutMillis: 1,
      statuses: ['purging'],
      mode: 'change',
    };
    // At 1 ms this sleep would be cancelled, if the field got through.
    await expect(
      withRetainedRunRead(pool, body, async (transaction) => {
        await transaction.db.execute('select pg_sleep(0.05)');
        return transaction.resources.role;
      }),
    ).resolves.toBe('owner');
  });
});

describe('the visible read under concurrency', () => {
  it('holds no lock: a removal goes through while it is open, and the read keeps its snapshot', async () => {
    const { workspaceId, owner, viewer } = await team();
    const { runId } = await seedRun(workspaceId, owner);
    const removal = new Client({ connectionString: adminDatabaseUrl });
    await removal.connect();
    await removal.query("set lock_timeout='3s'");
    try {
      const seen = await withRetainedRunRead(
        pool,
        { workspaceId, actorId: viewer },
        async (transaction) => {
          const before = transaction.resources.role;
          await removal.query(
            "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
            [workspaceId, viewer],
          );
          const rows = await transaction.db.execute(
            `select id from app.workflow_runs where id='${runId}'`,
          );
          return { before, rows: rows.rowCount };
        },
      );
      expect(seen).toEqual({ before: 'viewer', rows: 1 });
      expect(await runs.canRead({ workspaceId, actorId: viewer, runId })).toBe(
        false,
      );
    } finally {
      await removal.end();
    }
  });

  it('does not deadlock against removals and role changes', async () => {
    const { workspaceId, owner } = await team();
    const { runId } = await seedRun(workspaceId, owner);
    for (let round = 0; round < 15; round += 1) {
      const member = await join(workspaceId, 'viewer');
      const reads = [member, owner].flatMap((actorId) => [
        runs.list({ workspaceId, actorId, limit: 5 }),
        runs.canRead({ workspaceId, actorId, runId }),
        runs.statistics({ workspaceId, actorId, window: '24h' }),
      ]);
      const removal = identities.removeWorkspaceMember({
        workspaceId,
        actorUserId: owner,
        targetUserId: member,
        expectedRoleRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await expect(Promise.all([...reads, removal])).resolves.toBeDefined();
    }
  }, 60_000);
});
