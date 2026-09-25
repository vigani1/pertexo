import { describe, expect, it, vi } from 'vitest';

import type { IdentityWorkspaceDatabase } from '@pertexo/database/testing';

import { DatabaseIdentityWorkspaceAdapter } from '../../src/identity-workspace/index.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

  it('projects the stable identities from resolve-or-create', async () => {
    const resolveOrCreateIdentity = vi.fn().mockResolvedValue({
      user: { id: actorId },
      identity: { id: sessionId },
    });
    const adapter = adapterWith({ resolveOrCreateIdentity });
    const input = {
      issuer: 'https://issuer.example.test',
      providerSubject: 'subject-1',
      email: 'person@example.test',
      displayName: 'Person',
    };

    await expect(adapter.resolveOrCreateIdentity(input)).resolves.toEqual({
      userId: actorId,
      authenticationIdentityId: sessionId,
    });
    expect(resolveOrCreateIdentity).toHaveBeenCalledWith(input);
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

  it('maps a missing active session to undefined and forwards cancellation', async () => {
    const findActiveSessionByDigest = vi.fn().mockResolvedValue(null);
    const adapter = adapterWith({ findActiveSessionByDigest });
    const controller = new AbortController();

    await expect(
      adapter.findByDigest('b'.repeat(64), { signal: controller.signal }),
    ).resolves.toBeUndefined();
    expect(findActiveSessionByDigest).toHaveBeenCalledWith('b'.repeat(64), {
      signal: controller.signal,
    });
  });

  it.each([
    {
      name: 'null optional fields',
      record: {
        id: sessionId,
        tokenDigest: 'b'.repeat(64),
        userId: actorId,
        expiresAt: new Date('2026-08-20T13:00:00.000Z'),
        revokedAt: null,
        userAgent: null,
        ipAddress: null,
      },
      expected: { clientMetadata: {} },
    },
    {
      name: 'present optional fields',
      record: {
        id: sessionId,
        tokenDigest: 'b'.repeat(64),
        userId: actorId,
        expiresAt: new Date('2026-08-20T13:00:00.000Z'),
        revokedAt: new Date('2026-08-20T12:30:00.000Z'),
        userAgent: 'test-agent',
        ipAddress: '203.0.113.4',
      },
      expected: {
        revokedAt: new Date('2026-08-20T12:30:00.000Z'),
        clientMetadata: {
          userAgent: 'test-agent',
          ipAddress: '203.0.113.4',
        },
      },
    },
  ])('projects a session with $name', async ({ record, expected }) => {
    const adapter = adapterWith({
      findActiveSessionByDigest: vi.fn().mockResolvedValue(record),
    });

    await expect(adapter.findByDigest(record.tokenDigest)).resolves.toEqual({
      sessionId,
      tokenDigest: record.tokenDigest,
      userId: actorId,
      expiresAt: record.expiresAt,
      ...expected,
    });
  });

  it('forwards session creation with absent metadata as database nulls', async () => {
    const createSession = vi.fn().mockResolvedValue(undefined);
    const adapter = adapterWith({ createSession });
    const expiresAt = new Date('2026-08-20T13:00:00.000Z');

    await adapter.create({
      sessionId,
      tokenDigest: 'b'.repeat(64),
      userId: actorId,
      expiresAt,
      clientMetadata: {},
    });
    expect(createSession).toHaveBeenCalledWith({
      id: sessionId,
      tokenDigest: 'b'.repeat(64),
      userId: actorId,
      expiresAt,
      userAgent: null,
      ipAddress: null,
    });
  });

  it('forwards session creation metadata and digest-only revocation', async () => {
    const createSession = vi.fn().mockResolvedValue(undefined);
    const revokeSessionByDigest = vi.fn().mockResolvedValue(true);
    const adapter = adapterWith({ createSession, revokeSessionByDigest });
    const expiresAt = new Date('2026-08-20T13:00:00.000Z');

    await adapter.create({
      sessionId,
      tokenDigest: 'b'.repeat(64),
      userId: actorId,
      expiresAt,
      clientMetadata: { userAgent: 'test-agent', ipAddress: '203.0.113.4' },
    });
    await expect(
      adapter.revokeByDigest(
        'b'.repeat(64),
        new Date('2026-08-20T12:30:00.000Z'),
      ),
    ).resolves.toBe(true);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: 'test-agent',
        ipAddress: '203.0.113.4',
      }),
    );
    expect(revokeSessionByDigest).toHaveBeenCalledWith('b'.repeat(64));
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
