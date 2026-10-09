import { describe, expect, it, vi } from 'vitest';

import type { IdentityWorkspaceDatabase } from '@pertexo/database/testing';

import { DatabaseIdentityWorkspaceAdapter } from '../../src/workspaces/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function adapterWith(database: object): DatabaseIdentityWorkspaceAdapter {
  return new DatabaseIdentityWorkspaceAdapter(
    database as unknown as IdentityWorkspaceDatabase,
  );
}

describe('identity/workspace database adapter', () => {
  it('forwards actor-scoped workspace discovery without widening records', async () => {
    const page = { items: [], nextCursor: workspaceId };
    const listAccessibleWorkspaces = vi.fn().mockResolvedValue(page);
    const adapter = adapterWith({ listAccessibleWorkspaces });

    await expect(
      adapter.listAccessibleWorkspaces(actorId, {
        limit: 10,
        after: workspaceId,
      }),
    ).resolves.toBe(page);
    expect(listAccessibleWorkspaces).toHaveBeenCalledWith(actorId, {
      limit: 10,
      after: workspaceId,
    });
  });

  it('maps a missing user profile to null', async () => {
    const findUserById = vi.fn().mockResolvedValue(null);
    const adapter = adapterWith({ findUserById });

    await expect(adapter.findUserById(actorId)).resolves.toBeNull();
    expect(findUserById).toHaveBeenCalledWith(actorId);
  });

  it('projects every present user-profile field', async () => {
    const profile = {
      id: actorId,
      email: 'person@example.test',
      displayName: 'Person',
      status: 'active' as const,
      profileRevision: 2,
      createdAt: new Date('2026-08-20T12:00:00.000Z'),
      updatedAt: new Date('2026-08-21T12:00:00.000Z'),
    };
    const adapter = adapterWith({
      findUserById: vi.fn().mockResolvedValue(profile),
    });

    await expect(adapter.findUserById(actorId)).resolves.toEqual(profile);
  });

  it('forwards workspace-access cancellation and projects the result', async () => {
    const access = {
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    };
    const findWorkspaceAccess = vi.fn().mockResolvedValue(access);
    const adapter = adapterWith({ findWorkspaceAccess });
    const controller = new AbortController();

    await expect(
      adapter.findAccess({
        actorId,
        workspaceId,
        signal: controller.signal,
      }),
    ).resolves.toEqual(access);
    expect(findWorkspaceAccess).toHaveBeenCalledWith(actorId, workspaceId, {
      signal: controller.signal,
    });
  });
});
