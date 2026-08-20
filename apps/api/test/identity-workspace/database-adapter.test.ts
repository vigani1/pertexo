import { describe, expect, it, vi } from 'vitest';

import type { IdentityWorkspaceDatabase } from '@pertexo/database';

import { DatabaseIdentityWorkspaceAdapter } from '../../src/identity-workspace/index.js';

describe('identity/workspace database adapter', () => {
  it('uses the atomic digest revocation seam and exposes workspace access lookup', async () => {
    const revokeSessionByDigest = vi.fn().mockResolvedValue(true);
    const findWorkspaceAccess = vi.fn().mockResolvedValue({
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    });
    const database = {
      revokeSessionByDigest,
      findWorkspaceAccess,
    } as unknown as IdentityWorkspaceDatabase;
    const adapter = new DatabaseIdentityWorkspaceAdapter(database);

    await expect(
      adapter.revokeByDigest('a'.repeat(64), new Date()),
    ).resolves.toBe(true);
    expect(revokeSessionByDigest).toHaveBeenCalledWith('a'.repeat(64));
    await expect(
      adapter.findAccess({
        actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ).resolves.toMatchObject({ role: 'owner' });
  });
});
