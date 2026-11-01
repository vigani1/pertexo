import { randomUUID } from 'node:crypto';

import { ALL_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdempotencyRequestConflictError } from '../../src/runs/commands/acceptance/errors.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  change,
} from './workspace-deletion/fixture.js';
import {
  COMMANDS,
  lifecycleWrites,
  newWorkspace,
  putWorkspaceIn,
  statusOf,
  type Status,
} from './workspace-deletion/workspaces.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);

/** What each status lets each command do. */
const APPLIES: Readonly<Record<Status, readonly (typeof COMMANDS)[number][]>> =
  {
    active: ['deletion_requested'],
    suspended: ['deletion_requested', 'reactivated'],
    pending_deletion: ['deletion_restored'],
    purging: [],
    deleted: [],
  };
const RESULT_STATUS: Readonly<Record<(typeof COMMANDS)[number], Status>> = {
  deletion_requested: 'pending_deletion',
  // A restored workspace comes back suspended; its owner then reactivates it.
  deletion_restored: 'suspended',
  reactivated: 'active',
};

describe('the workspace status list', () => {
  it('holds exactly the statuses the old literal did', () => {
    expect([...ALL_WORKSPACE_STATUSES]).toEqual([
      'active',
      'suspended',
      'pending_deletion',
      'purging',
      'deleted',
    ]);
  });
});

describe('who can change a workspace lifecycle', () => {
  describe.each(COMMANDS)('%s', (commandType) => {
    it.each(['admin', 'builder', 'operator', 'viewer'] as const)(
      'refuses a member who is %s and writes nothing',
      async (role) => {
        const workspace = await newWorkspace();
        const actorUserId = await workspace.addMember(role);
        const status =
          commandType === 'deletion_requested' ? 'active' : 'suspended';
        await putWorkspaceIn(workspace.id, status);

        await expect(
          change({ commandType, actorUserId, workspaceId: workspace.id }),
        ).rejects.toMatchObject({ reason: 'actor_inactive' });

        expect(await statusOf(workspace.id)).toBe(status);
        expect(await lifecycleWrites(workspace.id)).toEqual(0);
      },
    );

    it.each([
      ['an outsider', 'outsider'],
      ['a suspended owner', 'owner_suspended'],
      ['an owner whose membership is suspended', 'membership_suspended'],
      ['an owner whose membership was removed', 'membership_removed'],
    ] as const)('refuses %s and writes nothing', async (_name, kind) => {
      const workspace = await newWorkspace();
      await putWorkspaceIn(
        workspace.id,
        commandType === 'deletion_requested' ? 'active' : 'suspended',
      );
      const actorUserId = await workspace.disqualify(kind);

      await expect(
        change({ commandType, actorUserId, workspaceId: workspace.id }),
      ).rejects.toMatchObject({ reason: 'actor_inactive' });

      expect(await lifecycleWrites(workspace.id)).toEqual(0);
    });
  });
});

describe('which status each command applies to', () => {
  const pairs = ALL_WORKSPACE_STATUSES.flatMap((status) =>
    COMMANDS.map((commandType) => ({ status, commandType })),
  );

  it.each(pairs)(
    '$commandType on a $status workspace',
    async ({ status, commandType }) => {
      const workspace = await newWorkspace();
      await putWorkspaceIn(workspace.id, status);

      const attempt = change({
        commandType,
        actorUserId: workspace.ownerId,
        workspaceId: workspace.id,
      });

      if (APPLIES[status].includes(commandType)) {
        await expect(attempt).resolves.toMatchObject({ commandType });
        expect(await statusOf(workspace.id)).toBe(RESULT_STATUS[commandType]);
        expect(await lifecycleWrites(workspace.id)).toBe(1);
      } else {
        await expect(attempt).rejects.toMatchObject({
          reason: 'invalid_state',
        });
        expect(await statusOf(workspace.id)).toBe(status);
        expect(await lifecycleWrites(workspace.id)).toBe(0);
      }
    },
  );

  it('restores a pending workspace only until its purge is due', async () => {
    const workspace = await newWorkspace();
    await putWorkspaceIn(workspace.id, 'pending_deletion');
    await workspace.passRecoveryPeriod();

    await expect(
      change({
        commandType: 'deletion_restored',
        actorUserId: workspace.ownerId,
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_state' });
  });
});

describe('retrying a lifecycle command', () => {
  async function deleted() {
    const workspace = await newWorkspace();
    const key = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const first = await change({
      commandType: 'deletion_requested',
      actorUserId: workspace.ownerId,
      workspaceId: workspace.id,
      idempotencyKeyHash: key,
    });
    return { workspace, key, first };
  }

  it.each(['pending_deletion', 'active', 'purging', 'deleted'] as const)(
    'returns the first receipt with the workspace now %s',
    async (status) => {
      const { workspace, key, first } = await deleted();
      await putWorkspaceIn(workspace.id, status);

      // A deleted workspace has no owner left to ask, so its row is what stops it.
      const retry = change({
        commandType: 'deletion_requested',
        actorUserId: workspace.ownerId,
        workspaceId: workspace.id,
        idempotencyKeyHash: key,
      });

      await expect(retry).resolves.toEqual(first);
      expect(await lifecycleWrites(workspace.id)).toBe(1);
    },
  );

  it('refuses the same key for a different request', async () => {
    const { workspace, key } = await deleted();

    await expect(
      change({
        commandType: 'deletion_requested',
        actorUserId: workspace.ownerId,
        workspaceId: workspace.id,
        idempotencyKeyHash: key,
        requestHash: '2'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });

  it('refuses the same key for a different command', async () => {
    const { workspace, key } = await deleted();

    await expect(
      change({
        commandType: 'deletion_restored',
        actorUserId: workspace.ownerId,
        workspaceId: workspace.id,
        idempotencyKeyHash: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
  });
});
