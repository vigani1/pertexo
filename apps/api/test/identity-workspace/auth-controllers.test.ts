import { describe, expect, it, vi } from 'vitest';

import {
  DoubleSubmitCsrfPolicy,
  IdentityError,
  nodeIdentityCrypto,
  OpaqueSessionService,
  type OidcLoginService,
} from '../../src/identity/index.js';
import {
  OidcController,
  SessionController,
  type CookieResponse,
} from '../../src/identity-workspace/index.js';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function oidcController(
  oidc: object,
  sessions: object,
  policy: Readonly<{
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
  }> = { secure: true, sameSite: 'lax' },
): OidcController {
  return new OidcController(
    oidc as unknown as OidcLoginService,
    sessions as unknown as OpaqueSessionService,
    new DoubleSubmitCsrfPolicy(nodeIdentityCrypto),
    policy,
  );
}

function completedLogin() {
  return {
    externalIdentity: {
      issuer: 'https://issuer.example.test',
      subject: 'subject',
    },
    internalIdentity: { userId },
    verifiedProfile: {
      email: 'person@example.test',
      displayName: 'Person',
      emailVerified: true,
    },
  };
}

describe('identity authentication controllers', () => {
  it('sets a narrow HttpOnly OIDC binding cookie without returning its value', async () => {
    const startLogin = vi.fn().mockResolvedValue({
      authorizationUrl: 'https://issuer.example.test/authorize?state=opaque',
      expiresAt: new Date('2026-08-20T12:05:00.000Z'),
      browserBindingMaxAgeSeconds: 300,
      browserBinding: 'raw-browser-binding',
    });
    const response: CookieResponse = { header: vi.fn() };
    const controller = oidcController({ startLogin }, { issue: vi.fn() });

    const body = await controller.start(response);

    expect(body).toEqual({
      authorizationUrl: 'https://issuer.example.test/authorize?state=opaque',
      expiresAt: '2026-08-20T12:05:00.000Z',
    });
    expect(JSON.stringify(body)).not.toContain('raw-browser-binding');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith(
      'set-cookie',
      expect.stringMatching(
        /^pertexo_oidc_binding=raw-browser-binding; Path=\/v1\/auth\/oidc\/callback; HttpOnly; Secure; SameSite=Lax; Expires=.+; Max-Age=300$/u,
      ),
    );
  });

  it('projects callback extensions and writes aligned binding, session, and CSRF cookies', async () => {
    const completeLogin = vi.fn().mockResolvedValue(completedLogin());
    const issue = vi.fn(
      (
        _input: unknown,
        boundary: {
          writeSessionCookie(
            token: string,
            options: Readonly<{
              httpOnly: true;
              secure: boolean;
              sameSite: 'lax' | 'strict' | 'none';
              path: '/';
              maxAgeSeconds: number;
            }>,
          ): void;
        },
      ) => {
        boundary.writeSessionCookie('opaque-session-token', {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/',
          maxAgeSeconds: 900,
        });
        return Promise.resolve({
          sessionId,
          expiresAt: new Date('2026-08-20T20:00:00.000Z'),
          cookieOptions: {
            httpOnly: true as const,
            secure: true,
            sameSite: 'strict' as const,
            path: '/' as const,
            maxAgeSeconds: 900,
          },
        });
      },
    );
    const response: CookieResponse = { header: vi.fn() };
    const controller = oidcController(
      { completeLogin },
      { issue },
      { secure: true, sameSite: 'strict' },
    );

    await controller.callback(
      {
        code: 'authorization-code',
        state: 'state-value-123456',
        provider_extension: 'ignored',
      },
      { cookies: { pertexo_oidc_binding: 'browser-binding' } },
      response,
    );

    expect(completeLogin).toHaveBeenCalledWith(
      { code: 'authorization-code', state: 'state-value-123456' },
      'browser-binding',
    );
    expect(issue.mock.calls[0]?.[0]).toEqual({ userId });
    expect(typeof issue.mock.calls[0]?.[1].writeSessionCookie).toBe('function');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith(
      'set-cookie',
      expect.arrayContaining([
        expect.stringContaining('pertexo_session=opaque-session-token'),
        expect.stringContaining('pertexo_oidc_binding=;'),
        expect.stringMatching(
          /^pertexo_csrf=[^;]+; Path=\/; Secure; SameSite=Strict; Max-Age=900$/,
        ),
      ]),
    );
  });

  it('revokes the persisted session when the combined cookie header fails', async () => {
    let revokedAt: Date | undefined;
    const sessions = new OpaqueSessionService({
      create: () => Promise.resolve(),
      findByDigest: () => Promise.resolve(undefined),
      revokeByDigest: (_digest, at) => {
        revokedAt = at;
        return Promise.resolve(true);
      },
    });
    const controller = oidcController(
      { completeLogin: () => Promise.resolve(completedLogin()) },
      sessions,
    );

    await expect(
      controller.callback(
        { code: 'authorization-code', state: 'state-value-123456' },
        { cookies: { pertexo_oidc_binding: 'browser-binding' } },
        {
          header: () => {
            throw new Error('response header unavailable');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'identity.session_invalid' });
    expect(revokedAt).toBeInstanceOf(Date);
  });

  it('clears cookies using the configured policy after logout revocation', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionController(
      { revoke } as unknown as OpaqueSessionService,
      { secure: false, sameSite: 'strict' },
    );
    const response: CookieResponse = { header: vi.fn() };

    await controller.logout(
      {
        cookies: { pertexo_session: 'opaque-session-token-123456789012345678' },
      },
      response,
    );

    expect(revoke).toHaveBeenCalledWith(
      'opaque-session-token-123456789012345678',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith('set-cookie', [
      'pertexo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
      'pertexo_csrf=; Path=/; Max-Age=0; SameSite=Strict',
    ]);
  });

  it('clears the binding cookie and preserves a malformed callback failure', async () => {
    const response: CookieResponse = { header: vi.fn() };
    const completeLogin = vi.fn();
    const controller = oidcController({ completeLogin }, { issue: vi.fn() });

    await expect(
      controller.callback(
        { code: 'authorization-code', state: 'short' },
        {},
        response,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(completeLogin).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith(
      'set-cookie',
      expect.stringContaining('pertexo_oidc_binding=;'),
    );
  });

  it('preserves a provider outage when binding-cookie cleanup also fails', async () => {
    const providerFailure = new IdentityError('identity.provider_unavailable');
    const controller = oidcController(
      { completeLogin: vi.fn().mockRejectedValue(providerFailure) },
      { issue: vi.fn() },
    );

    await expect(
      controller.callback(
        { code: 'authorization-code', state: 'state-value-123456' },
        { cookies: { pertexo_oidc_binding: 'browser-binding' } },
        {
          header: () => {
            throw new Error('cleanup response failure');
          },
        },
      ),
    ).rejects.toBe(providerFailure);
  });
});
