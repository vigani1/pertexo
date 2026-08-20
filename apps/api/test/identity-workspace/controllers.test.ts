import { describe, expect, it, vi } from 'vitest';

import {
  DoubleSubmitCsrfPolicy,
  IdentityError,
  nodeIdentityCrypto,
  OpaqueSessionService,
} from '../../src/identity/index.js';
import type { OidcLoginService } from '../../src/identity/index.js';
import {
  OidcController,
  SessionController,
  WorkspaceController,
  type CookieResponse,
} from '../../src/identity-workspace/index.js';
import type { IdentityWorkspaceRequest } from '../../src/identity-workspace/index.js';

describe('identity/workspace controllers', () => {
  it('writes session and CSRF cookies in one aligned response header', async () => {
    const oidc = {
      completeLogin: vi.fn().mockResolvedValue({
        externalIdentity: {
          issuer: 'https://issuer.example.test',
          subject: 'subject',
        },
        internalIdentity: {
          userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
        verifiedProfile: {
          email: 'person@example.test',
          displayName: 'Person',
        },
      }),
    } as unknown as OidcLoginService;
    const sessions = {
      issue: vi.fn(
        (
          _input: unknown,
          boundary: {
            writeSessionCookie: (
              token: string,
              options: Readonly<{
                httpOnly: true;
                secure: boolean;
                sameSite: 'lax' | 'strict' | 'none';
                path: '/';
                maxAgeSeconds: number;
              }>,
            ) => void;
          },
        ) => {
          boundary.writeSessionCookie('opaque-session-token', {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            path: '/',
            maxAgeSeconds: 900,
          });
          return {
            sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            expiresAt: new Date('2026-08-20T20:00:00.000Z'),
            cookieOptions: {
              httpOnly: true,
              secure: true,
              sameSite: 'strict' as const,
              path: '/',
              maxAgeSeconds: 900,
            },
          };
        },
      ),
    };
    const response: CookieResponse = { header: vi.fn() };
    const controller = new OidcController(
      oidc,
      sessions as never,
      new DoubleSubmitCsrfPolicy(nodeIdentityCrypto),
    );

    await controller.callback(
      { code: 'authorization-code', state: 'state-value-123456' },
      response,
    );

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith(
      'set-cookie',
      expect.arrayContaining([
        expect.stringContaining('pertexo_session=opaque-session-token'),
        expect.stringMatching(
          /^pertexo_csrf=[^;]+; Path=\/; Secure; SameSite=Strict; Max-Age=900$/,
        ),
      ]),
    );
  });

  it('revokes the persisted session when the combined cookie header fails', async () => {
    let revokedAt: Date | undefined;
    const store = {
      create: (): Promise<void> => Promise.resolve(),
      findByDigest: (): Promise<undefined> => Promise.resolve(undefined),
      revokeByDigest: (_digest: string, at: Date): Promise<boolean> => {
        revokedAt = at;
        return Promise.resolve(true);
      },
    };
    const sessions = new OpaqueSessionService(store);
    const oidc = {
      completeLogin: () =>
        Promise.resolve({
          externalIdentity: {
            issuer: 'https://issuer.example.test',
            subject: 'subject',
          },
          internalIdentity: {
            userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          verifiedProfile: {
            email: 'person@example.test',
            displayName: 'Person',
          },
        }),
    } as unknown as OidcLoginService;
    const response: CookieResponse = {
      header: () => {
        throw new Error('response header unavailable');
      },
    };
    const controller = new OidcController(
      oidc,
      sessions,
      new DoubleSubmitCsrfPolicy(nodeIdentityCrypto),
    );

    await expect(
      controller.callback(
        { code: 'authorization-code', state: 'state-value-123456' },
        response,
      ),
    ).rejects.toMatchObject({ code: 'auth.unauthenticated' });
    expect(revokedAt).toBeInstanceOf(Date);
  });

  it('clears cookies using the configured policy after logout revocation', async () => {
    let revoked = false;
    const sessions = new OpaqueSessionService({
      create: (): Promise<void> => Promise.resolve(),
      findByDigest: (): Promise<undefined> => Promise.resolve(undefined),
      revokeByDigest: (): Promise<boolean> => {
        revoked = true;
        return Promise.resolve(true);
      },
    });
    const response: CookieResponse = { header: vi.fn() };
    const controller = new SessionController(sessions, {
      secure: false,
      sameSite: 'strict',
    });

    await controller.logout(
      {
        cookies: { pertexo_session: 'opaque-session-token-123456789012345678' },
      },
      response,
    );

    expect(revoked).toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith('set-cookie', [
      'pertexo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
      'pertexo_csrf=; Path=/; Max-Age=0; SameSite=Strict',
    ]);
  });

  it('maps malformed query, body, and route inputs to request.invalid', async () => {
    const oidc = {
      completeLogin: vi.fn(),
    } as unknown as OidcLoginService;
    const oidcController = new OidcController(
      oidc,
      { issue: vi.fn() } as never,
      new DoubleSubmitCsrfPolicy(nodeIdentityCrypto),
    );
    await expect(
      oidcController.callback(
        { code: 'authorization-code', state: 'short' },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });

    const workspaceController = new WorkspaceController(
      { execute: vi.fn() } as never,
      { requestDeletion: vi.fn(), restore: vi.fn() } as never,
    );
    const request = {
      identitySession: {
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expiresAt: new Date(),
        clientMetadata: {},
      },
    } satisfies IdentityWorkspaceRequest;
    await expect(
      workspaceController.create(request, { name: '', slug: 'not valid' }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      workspaceController.requestDeletion(
        request,
        { workspaceId: 'not-a-uuid' },
        { reason: 'retire it' },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });

    await expect(
      workspaceController.create(request, {
        name: 'Missing key',
        slug: 'missing-key',
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      workspaceController.create(
        {
          ...request,
          headers: { 'idempotency-key': ['one', 'two'] },
        },
        { name: 'Ambiguous key', slug: 'ambiguous-key' },
      ),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  });

  it('maps an OIDC provider outage to the stable application error', async () => {
    const oidc = {
      completeLogin: vi
        .fn()
        .mockRejectedValue(new IdentityError('identity.provider_unavailable')),
    } as unknown as OidcLoginService;
    const controller = new OidcController(
      oidc,
      { issue: vi.fn() } as never,
      new DoubleSubmitCsrfPolicy(nodeIdentityCrypto),
    );

    await expect(
      controller.callback(
        { code: 'authorization-code', state: 'state-value-123456' },
        { header: vi.fn() },
      ),
    ).rejects.toMatchObject({
      code: 'provider.unavailable',
      safeDetail: 'The identity provider is temporarily unavailable.',
    });
  });
});
