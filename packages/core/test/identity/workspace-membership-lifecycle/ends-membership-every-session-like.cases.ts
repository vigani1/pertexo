import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { WorkspaceMembershipCommandConflictError } from '../../../src/testing.js';

import { database, membership, facts, team } from './fixture.js';

export function registerEndsMembershipEverySessionLike(): void {
  it('ends the membership and every session like a removal, and replays exactly', async () => {
    const { owner, workspaceId, members } = await team('builder');
    const [leaver = ''] = members;
    await database.sessions(leaver);
    const leave = {
      workspaceId,
      actorUserId: leaver,
      idempotencyKey: `leave-${randomUUID()}`,
      requestId: 'leave-request',
    };

    await expect(database.identity().leaveWorkspace(leave)).resolves.toEqual({
      userId: leaver,
      roleRevision: 2,
      replayed: false,
    });
    await expect(membership(workspaceId, leaver)).resolves.toEqual({
      status: 'removed',
      role: 'builder',
      role_revision: 2,
    });
    await expect(database.liveSessions(leaver)).resolves.toBe(0);
    await expect(
      database.identity().listAccessibleWorkspaces(leaver),
    ).resolves.toMatchObject({ items: [] });
    await expect(database.identity().leaveWorkspace(leave)).resolves.toEqual({
      userId: leaver,
      roleRevision: 2,
      replayed: true,
    });
    await expect(
      database
        .identity()
        .leaveWorkspace({ ...leave, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
    await expect(facts(workspaceId, 'workspace.member_left')).resolves.toEqual([
      {
        actor_user_id: leaver,
        target_id: leaver,
        metadata: { role: 'builder', fromRevision: 1, toRevision: 2 },
      },
    ]);

    const refusal = database.identity().leaveWorkspace({
      workspaceId,
      actorUserId: owner,
      idempotencyKey: randomUUID(),
    });
    await expect(refusal).rejects.toBeInstanceOf(
      WorkspaceMembershipCommandConflictError,
    );
    await expect(refusal).rejects.toMatchObject({ reason: 'owner_departure' });
    await expect(
      database.identity().leaveWorkspace({
        workspaceId,
        actorUserId: (await database.user('Stranger')).id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'actor_inactive' });
  });

  it('coalesces concurrent duplicates and rolls back a late failure', async () => {
    const { workspaceId, members } = await team('viewer');
    const [leaver = ''] = members;
    await database.sessions(leaver);
    const failing = {
      workspaceId,
      actorUserId: leaver,
      idempotencyKey: randomUUID(),
      requestId: 'x'.repeat(129),
    };
    await expect(
      database.identity().leaveWorkspace(failing),
    ).rejects.toMatchObject({ code: '22001' });
    await expect(membership(workspaceId, leaver)).resolves.toMatchObject({
      status: 'active',
      role_revision: 1,
    });
    await expect(database.liveSessions(leaver)).resolves.toBe(1);

    const leave = { workspaceId, actorUserId: leaver, idempotencyKey: 'once' };
    const receipts = await Promise.all([
      database.identity().leaveWorkspace(leave),
      database.identity().leaveWorkspace(leave),
    ]);
    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      facts(workspaceId, 'workspace.member_left'),
    ).resolves.toHaveLength(1);
  });
}
