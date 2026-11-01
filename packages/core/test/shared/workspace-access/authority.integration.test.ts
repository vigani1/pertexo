import { randomUUID } from 'node:crypto';

import { WorkspaceAccessDeniedError } from '../../../src/tenant-access/index.js';
import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
  type WorkspaceStatusList,
} from '@pertexo/workflow-model';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { withWorkspaceAccess } from '../../../src/shared/index.js';

import { admin } from '../../lifecycle/calls/fixtures.js';
import {
  adminUrl,
  apiUrl,
  userId,
  withApplicationName,
  withDatabase,
} from '../../lifecycle/retention.support.js';
import { waitForApplicationLock } from '../../support/postgres/lock-coordination.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  member,
  pool,
} from '../../variables/configuration/fixture.js';
import { anyMember, MODES, setStatus, withImpatientClient } from './support.js';

const waitingApplication = `workspace-access-${randomUUID()}`;
let waitingPool: Pool;

beforeAll(() => {
  beforeAllFixture1();
  waitingPool = new Pool({
    connectionString: withApplicationName(apiUrl, waitingApplication),
    max: 1,
  });
});
afterAll(async () => {
  await waitingPool.end();
  await afterAllFixture2();
});

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('the role it hands the operation', () => {
  it.each(MODES)('is the actor’s real role in %s mode', async (mode) => {
    const { workspaceId } = await fixture();
    const seen: Record<string, string> = {};
    const members: (readonly [string, string])[] = [['owner', userId]];
    for (const role of ['admin', 'builder', 'operator', 'viewer'])
      members.push([role, await member(workspaceId, role)]);
    for (const [expected, actorId] of members)
      seen[expected] = await withWorkspaceAccess(
        pool,
        { workspaceId, actorId },
        { mode, ...anyMember },
        (_client, role) => Promise.resolve(role),
      );
    expect(seen).toEqual({
      owner: 'owner',
      admin: 'admin',
      builder: 'builder',
      operator: 'operator',
      viewer: 'viewer',
    });
  });

  it.each(MODES)(
    'does not exist for someone with no membership, whose operation never runs in %s mode',
    async (mode) => {
      const { workspaceId } = await fixture();
      const outsider = await member((await fixture()).workspaceId, 'admin');
      const operation = vi.fn(() => Promise.resolve());
      await expect(
        withWorkspaceAccess(
          pool,
          { workspaceId, actorId: outsider },
          { mode, ...anyMember },
          operation,
        ),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(MODES)(
    'is not enough without the capability, in %s mode',
    async (mode) => {
      const { workspaceId } = await fixture();
      const operation = vi.fn(() => Promise.resolve());
      await expect(
        withWorkspaceAccess(
          pool,
          { workspaceId, actorId: await member(workspaceId, 'viewer') },
          {
            mode,
            capability: 'variable:manage',
            statuses: UNPURGED_WORKSPACE_STATUSES,
          },
          operation,
        ),
      ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      expect(operation).not.toHaveBeenCalled();
    },
  );
});

describe('each status list', () => {
  const lists: readonly (readonly [
    string,
    WorkspaceStatusList,
    readonly string[],
  ])[] = [
    ['active only', ACTIVE_WORKSPACE_STATUSES, ['active']],
    ['browsable', BROWSABLE_WORKSPACE_STATUSES, ['active', 'suspended']],
    [
      'unpurged',
      UNPURGED_WORKSPACE_STATUSES,
      ['active', 'suspended', 'pending_deletion'],
    ],
  ];

  it.each(lists)(
    '%s lets in exactly the workspaces it names, in both modes',
    async (_name, statuses, allowed) => {
      const admitted: string[] = [];
      for (const status of [
        'active',
        'suspended',
        'pending_deletion',
        'purging',
      ]) {
        const { workspaceId } = await fixture();
        await setStatus(workspaceId, status);
        for (const mode of MODES) {
          const passed = await withWorkspaceAccess(
            pool,
            { workspaceId, actorId: userId },
            { mode, capability: 'workspace:read', statuses },
            () => Promise.resolve(true),
          ).catch((error: unknown) => {
            expect(error).toBeInstanceOf(WorkspaceAccessDeniedError);
            return false;
          });
          if (passed) admitted.push(`${status} ${mode}`);
        }
      }
      expect(admitted).toEqual(
        allowed.flatMap((status) => [`${status} read`, `${status} change`]),
      );
    },
  );
});

describe('authority while a change is open', () => {
  /** Each is something that would take away the authority the change relies on. */
  const revocations = [
    [
      'the workspace being suspended',
      "update app.workspaces set status='suspended' where id=$1",
      'workspaceId',
    ],
    [
      'the membership being removed',
      "update app.workspace_memberships set status='removed' where user_id=$1",
      'actorId',
    ],
    [
      'the actor being suspended',
      "update app.users set status='suspended' where id=$1",
      'actorId',
    ],
  ] as const;

  it.each(revocations)(
    'makes %s wait for the change to commit',
    async (_case, statement, target) => {
      const { workspaceId } = await fixture();
      const actorId = await member(workspaceId, 'admin');
      const started = gate();
      const finish = gate();
      const application = `revocation-${randomUUID()}`;
      const revoker = new Client({
        connectionString: withApplicationName(
          withDatabase(adminUrl),
          application,
        ),
      });
      await revoker.connect();
      try {
        const change = withWorkspaceAccess(
          pool,
          { workspaceId, actorId },
          { mode: 'change', ...anyMember },
          async () => {
            started.open();
            await finish.opened;
          },
        );
        await started.opened;
        const revoked = revoker.query(statement, [
          target === 'workspaceId' ? workspaceId : actorId,
        ]);
        await waitForApplicationLock(admin, application);
        finish.open();
        await change;
        expect((await revoked).rowCount).toBe(1);
      } finally {
        finish.open();
        await revoker.end();
      }
    },
  );

  it.each(revocations)(
    'does not hold up %s during a read',
    async (_case, statement, target) => {
      const { workspaceId } = await fixture();
      const actorId = await member(workspaceId, 'admin');
      const result = await withImpatientClient((revoker) =>
        withWorkspaceAccess(
          pool,
          { workspaceId, actorId },
          { mode: 'read', ...anyMember },
          () =>
            revoker.query(statement, [
              target === 'workspaceId' ? workspaceId : actorId,
            ]),
        ),
      );
      expect(result.rowCount).toBe(1);
    },
  );

  it.each([
    ['commits', 'commit', 'refused'],
    ['rolls back', 'rollback', 'admitted'],
  ] as const)(
    'decides after waiting: when an open suspension %s, the change is %s',
    async (_case, finish, outcome) => {
      const { workspaceId } = await fixture();
      const operation = vi.fn(() => Promise.resolve());
      const suspender = new Client({
        connectionString: withDatabase(adminUrl),
      });
      await suspender.connect();
      try {
        await suspender.query('begin');
        await suspender.query(
          "update app.workspaces set status='suspended' where id=$1",
          [workspaceId],
        );
        const change = withWorkspaceAccess(
          waitingPool,
          { workspaceId, actorId: userId },
          {
            mode: 'change',
            capability: 'workspace:read',
            statuses: ACTIVE_WORKSPACE_STATUSES,
          },
          operation,
        ).then(
          () => 'admitted',
          (error: unknown) => {
            expect(error).toBeInstanceOf(WorkspaceAccessDeniedError);
            return 'refused';
          },
        );
        await waitForApplicationLock(admin, waitingApplication);
        await suspender.query(finish);
        expect(await change).toBe(outcome);
        expect(operation).toHaveBeenCalledTimes(outcome === 'admitted' ? 1 : 0);
      } finally {
        await suspender.end();
      }
    },
  );
});
