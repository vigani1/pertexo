import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';
import {
  createApiPlatformFixture,
  createStubIdentityRuntime,
} from '../../support/api-platform.fixture.js';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const invitationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const csrf = 'c'.repeat(32);
const headers = {
  cookie: `pertexo_session=${'s'.repeat(43)}; pertexo_csrf=${csrf}`,
  'x-csrf-token': csrf,
  origin: 'https://app.example.test',
  'idempotency-key': 'unconfigured-invitations',
};
let application:
  Awaited<ReturnType<typeof createTestApiApplication>> | undefined;

afterEach(async () => {
  await application?.close();
});

describe('unconfigured invitation issuance', () => {
  it('lists and revokes existing invitations, refuses create/resend with 503, and preserves access checks', async () => {
    const now = new Date('2026-10-11T10:00:00Z');
    const invitation = {
      id: invitationId,
      workspaceId,
      email: 'invited@example.test',
      role: 'viewer' as const,
      status: 'pending' as const,
      revision: 1,
      deliveryStatus: 'queued' as const,
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const identity = createStubIdentityRuntime(userId, {
      findAccess: (query) =>
        Promise.resolve(
          query.workspaceId === workspaceId
            ? {
                actorId: userId,
                workspaceId,
                role: 'owner' as const,
                membershipStatus: 'active' as const,
                workspaceStatus: 'active' as const,
              }
            : undefined,
        ),
    });
    const create = vi.fn();
    const resend = vi.fn();
    const revoke = vi.fn().mockResolvedValue({
      invitation: { ...invitation, status: 'revoked', revision: 2 },
      replayed: false,
    });
    const { config, ...platform } =
      createApiPlatformFixture('0000_baseline.sql');
    application = await createTestApiApplication(config, {
      ...platform,
      identityRuntime: {
        ...identity,
        dependencies: {
          ...identity.dependencies,
          persistence: {
            ...identity.dependencies.persistence,
            listWorkspaceInvitations: () =>
              Promise.resolve({ items: [invitation] }),
            createWorkspaceInvitation: create,
            resendWorkspaceInvitation: resend,
            revokeWorkspaceInvitation: revoke,
          },
        },
      },
    });
    await application.init();
    const url = `/v1/workspaces/${workspaceId}/invitations`;
    expect((await application.inject({ method: 'GET', url })).statusCode).toBe(
      401,
    );
    expect(
      (
        await application.inject({
          method: 'GET',
          url: url.replace(workspaceId, invitationId),
          headers,
        })
      ).statusCode,
    ).toBe(403);
    const listed = await application.inject({ method: 'GET', url, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      issuanceAvailable: false,
      items: [{ id: invitationId }],
    });
    for (const command of [
      { url, payload: { email: 'new@example.test', role: 'viewer' } },
      {
        url: `${url}/${invitationId}/resend`,
        payload: { expectedRevision: 1 },
      },
    ]) {
      const result = await application.inject({
        method: 'POST',
        ...command,
        headers,
      });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toMatchObject({
        code: 'workspace.invitation_not_configured',
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
    const revoked = await application.inject({
      method: 'POST',
      url: `${url}/${invitationId}/revoke`,
      headers,
      payload: { expectedRevision: 1 },
    });
    expect(revoked.statusCode).toBe(202);
    expect(revoked.json()).toMatchObject({
      invitation: { status: 'revoked', revision: 2 },
    });
    expect(revoke).toHaveBeenCalledOnce();
  });
});
