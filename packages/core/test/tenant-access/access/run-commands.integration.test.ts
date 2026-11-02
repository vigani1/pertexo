import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkflowRunNotFoundError } from '../../../src/runs/errors.js';
import { withRunCommand } from '../../../src/runs/queries/access.queries.js';
import { waitForApplicationLock } from '../../support/postgres/lock-coordination.js';
import {
  admin,
  adminDatabaseUrl,
  appDatabaseUrl,
  closeWorld,
  gate,
  identities,
  join,
  openWorld,
  outcomes,
  person,
  pool,
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

const cancelRequested = async (runId: string) =>
  (
    await admin.query<{ cancel_requested_at: Date | null }>(
      'select cancel_requested_at from app.workflow_runs where id=$1',
      [runId],
    )
  ).rows[0]?.cancel_requested_at;

describe('a run command someone may not make', () => {
  const refused: readonly (readonly [
    string,
    (world: Awaited<ReturnType<typeof team>>) => Promise<string>,
  ])[] = [
    ['someone who never belonged', () => person()],
    [
      'a member of another workspace',
      async () => {
        const stranger = await person();
        await workspaceOwnedBy(stranger);
        return stranger;
      },
    ],
    [
      'a removed member',
      async ({ workspaceId, operator }) => {
        await setMembership(workspaceId, operator, 'removed');
        return operator;
      },
    ],
    [
      'a suspended member',
      async ({ workspaceId, operator }) => {
        await setMembership(workspaceId, operator, 'suspended');
        return operator;
      },
    ],
    [
      'a deactivated user',
      async ({ operator }) => {
        await setUserStatus(operator, 'suspended');
        return operator;
      },
    ],
    ['a viewer, whose role has no such capability', (world) => Promise.resolve(world.viewer)],
  ];

  it.each(refused)(
    'reads as a run that is not there, for %s',
    async (_who, actor) => {
      const world = await team();
      const { runId } = await seedRun(world.workspaceId, world.owner, 'queued');
      await expect(
        runs.cancel({
          workspaceId: world.workspaceId,
          actorId: await actor(world),
          runId,
          reason: 'No',
        }),
      ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
      expect(await cancelRequested(runId)).toBeNull();
    },
  );

  it('reads the same for a run outside the actor’s folders', async () => {
    const { workspaceId, owner, builder } = await team();
    const { runId, workflowId } = await seedRun(workspaceId, owner, 'queued');
    await restrict(workspaceId, workflowId);
    await expect(
      runs.cancel({ workspaceId, actorId: builder, runId, reason: 'No' }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    expect(await cancelRequested(runId)).toBeNull();
  });

  it('reads the same for a run in another workspace, asked for through your own', async () => {
    const mine = await team();
    const theirs = await team();
    const { runId } = await seedRun(theirs.workspaceId, theirs.owner, 'queued');
    await expect(
      runs.cancel({
        workspaceId: mine.workspaceId,
        actorId: mine.owner,
        runId,
        reason: 'No',
      }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    expect(await cancelRequested(runId)).toBeNull();
  });
});

describe('a run command as a workspace leaves service', () => {
  it('goes through on an active workspace', async () => {
    const { workspaceId, owner, operator } = await team();
    const { runId } = await seedRun(workspaceId, owner, 'queued');
    const cancelled = await runs.cancel({
      workspaceId,
      actorId: operator,
      runId,
      reason: 'Stop',
    });
    expect(cancelled.run.id).toBe(runId);
    expect(cancelled.alreadyRequested).toBe(false);
    expect(await cancelRequested(runId)).toBeInstanceOf(Date);
  });

  it.each<WorkspaceStatus>([
    'suspended',
    'pending_deletion',
    'purging',
    'deleted',
  ])('reads as a run that is not there on %s, even for its owner', async (status) => {
    const { workspaceId, owner } = await team();
    const { runId } = await seedRun(workspaceId, owner, 'queued');
    await setStatus(workspaceId, status);
    await expect(
      runs.cancel({ workspaceId, actorId: owner, runId, reason: 'No' }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    expect(await cancelRequested(runId)).toBeNull();
  });
});

describe('the locks a run command holds', () => {
  const application = `run-command-${randomUUID()}`;
  const revocations = [
    [
      'the workspace being suspended',
      "update app.workspaces set status='suspended' where id=$1",
      'workspace',
    ],
    [
      'the membership being removed',
      "update app.workspace_memberships set status='removed' where user_id=$1",
      'actor',
    ],
    [
      'the actor being suspended',
      "update app.users set status='suspended' where id=$1",
      'actor',
    ],
  ] as const;

  it.each(revocations)(
    'makes %s wait for the command to commit',
    async (_case, statement, target) => {
      const { workspaceId, operator } = await team();
      const entered = gate();
      const finish = gate();
      const revoker = new Client({
        connectionString: adminDatabaseUrl,
        application_name: application,
      });
      await revoker.connect();
      try {
        const command = withRunCommand(
          pool,
          { workspaceId, actorId: operator },
          'run:cancel',
          async () => {
            entered.open();
            await finish.opened;
          },
        );
        await entered.opened;
        const revoked = revoker.query(statement, [
          target === 'workspace' ? workspaceId : operator,
        ]);
        await waitForApplicationLock(admin, application);
        finish.open();
        await command;
        expect((await revoked).rowCount).toBe(1);
      } finally {
        finish.open();
        await revoker.end();
      }
    },
  );

  it('is refused, not admitted, once a suspension it waited on commits', async () => {
    const { workspaceId, owner, operator } = await team();
    const { runId } = await seedRun(workspaceId, owner, 'queued');
    const waitingApplication = `run-command-waiting-${randomUUID()}`;
    const waiting = new Pool({
      connectionString: appDatabaseUrl,
      application_name: waitingApplication,
      max: 1,
    });
    const suspender = new Client({ connectionString: adminDatabaseUrl });
    await suspender.connect();
    try {
      await suspender.query('begin');
      await suspender.query(
        "update app.workspaces set status='suspended' where id=$1",
        [workspaceId],
      );
      const command = withRunCommand(
        waiting,
        { workspaceId, actorId: operator },
        'run:cancel',
        () => Promise.resolve('admitted'),
      ).catch((error: unknown) => error);
      await waitForApplicationLock(admin, waitingApplication);
      await suspender.query('commit');
      expect(await command).toBeInstanceOf(WorkflowRunNotFoundError);
      expect(await cancelRequested(runId)).toBeNull();
    } finally {
      await suspender.end();
      await waiting.end();
    }
  });

  it('does not deadlock against removals and invitation commands', async () => {
    const { workspaceId, owner, operator } = await team();
    for (let round = 0; round < 15; round += 1) {
      const leaving = await join(workspaceId, 'viewer');
      const queued = await Promise.all([
        seedRun(workspaceId, owner, 'queued'),
        seedRun(workspaceId, owner, 'queued'),
      ]);
      const results = await outcomes([
        ...queued.map(
          ({ runId }, index) =>
            () =>
              runs.cancel({
                workspaceId,
                actorId: index === 0 ? owner : operator,
                runId,
                reason: 'Stop',
              }),
        ),
        () =>
          identities.removeWorkspaceMember({
            workspaceId,
            actorUserId: owner,
            targetUserId: leaving,
            expectedRoleRevision: 1,
            idempotencyKey: randomUUID(),
          }),
        () =>
          identities.createWorkspaceInvitation({
            workspaceId,
            actorUserId: owner,
            email: `${randomUUID()}@example.test`,
            role: 'viewer',
            idempotencyKey: randomUUID(),
            tokenDigest: randomUUID().replaceAll('-', '').repeat(2),
            sealedToken: {
              ciphertext: 'sealed',
              nonce: 'nonce',
              tag: 'tag',
              keyVersion: 'v1',
            },
            expiresAt: new Date(Date.now() + 60_000),
          }),
      ]);
      expect(results).toEqual(results.map(() => 'done'));
    }
  }, 60_000);
});
