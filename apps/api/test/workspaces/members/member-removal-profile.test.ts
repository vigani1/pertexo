import {
  UserProfileCommandConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  type IdentityWorkspaceStore,
} from '@pertexo/core/tenant-access';
import { describe, expect, it, vi } from 'vitest';
import { workspaceFailure } from '../../../src/problems/context/normalize.js';
import { toProblem } from '../../../src/problems/registry.js';

import { createIdentityWorkspaceAdapter } from '../../../src/workspaces/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const at = new Date('2026-09-24T10:00:00.000Z');

function profile(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: actorId,
    email: 'person@example.test',
    displayName: 'Ada Lovelace',
    status: 'active' as const,
    profileRevision: 2,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('member removal and self profile commands', () => {
  it.each([
    ['target_missing', 'resource.not_found'],
    ['revision_conflict', 'workspace.member_role_revision_conflict'],
    ['target_inactive', 'workspace.member_removal_conflict'],
    ['self_removal', 'auth.forbidden'],
    ['owner_removal', 'auth.forbidden'],
    ['removal_forbidden', 'auth.forbidden'],
    ['actor_inactive', 'auth.forbidden'],
  ] as const)('maps removal %s to %s', (reason, code) => {
    expect(
      toProblem(
        workspaceFailure(
          new WorkspaceMemberRemovalCommandConflictError(
            reason,
            'unsafe detail',
          ),
        ),
      ),
    ).toMatchObject({ code });
  });

  it.each([
    ['revision_conflict', 'user.profile_revision_conflict'],
    ['idempotency_conflict', 'request.idempotency_conflict'],
    ['user_inactive', 'auth.unauthenticated'],
  ] as const)('maps profile %s to %s', (reason, code) => {
    expect(
      toProblem(
        workspaceFailure(
          new UserProfileCommandConflictError(reason, 'unsafe detail'),
        ),
      ),
    ).toMatchObject({ code });
  });

  it('adapts the database commands without leaking database records', async () => {
    const database = {
      removeWorkspaceMember: vi.fn().mockResolvedValue({
        userId: targetId,
        roleRevision: 2,
        replayed: true,
      }),
      updateUserProfile: vi.fn().mockResolvedValue({
        user: { ...profile(), internal: 'not projected' },
        changed: false,
        replayed: true,
      }),
    } as unknown as IdentityWorkspaceStore;
    const adapter = createIdentityWorkspaceAdapter(database);
    const removal = {
      workspaceId,
      actorUserId: actorId,
      targetUserId: targetId,
      expectedRoleRevision: 1,
      idempotencyKey: 'key',
    };

    await expect(adapter.removeWorkspaceMember(removal)).resolves.toEqual({
      userId: targetId,
      roleRevision: 2,
      replayed: true,
    });
    await expect(
      adapter.updateUserProfile({
        actorUserId: actorId,
        displayName: 'Ada Lovelace',
        expectedRevision: 2,
        idempotencyKey: 'key',
      }),
    ).resolves.toEqual({ user: profile(), changed: false, replayed: true });
  });
});
