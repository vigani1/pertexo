import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import {
  config,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerRegistersInjectedIdentityRuntimeOwnsClose(): void {
  it('registers an injected identity runtime and owns its close lifecycle', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const selectedIdentityRuntime = identityRuntime(close, true);
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
    });
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { cookie: 'pertexo_session=session' },
    });
    expect(response.statusCode).toBe(200);

    await applicationFixture.application.close();
    applicationFixture.application = undefined;
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails a composed protected route closed before application work when the limiter is unavailable', async () => {
    const selectedIdentityRuntime = identityRuntime(undefined, true);
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: selectedIdentityRuntime,
      rateLimitConsumer: {
        consume: () => Promise.reject(new Error('redis endpoint unavailable')),
      },
    });

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/invitation-acceptance',
      headers: { cookie: 'pertexo_session=session' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({
      code: 'request.rate_limit_unavailable',
      status: 503,
    });
    expect(response.payload).not.toContain('redis endpoint unavailable');
    expect(
      // eslint-disable-next-line @typescript-eslint/unbound-method
      selectedIdentityRuntime.dependencies.sessions.authenticate,
    ).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'registers all discovery routes with authentication=%s',
    async (authenticated) => {
      applicationFixture.application = await createTestApiApplication(config, {
        ...dependencies(),
        identityRuntime: identityRuntime(undefined, authenticated),
      });
      await applicationFixture.application.init();

      const routes = [
        '/v1/users/me',
        '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/members',
        '/v1/node-definitions',
        '/v1/integrations',
      ];
      for (const url of routes) {
        const response = await applicationFixture.application.inject({
          method: 'GET',
          url,
          ...(authenticated
            ? { headers: { cookie: `pertexo_session=${'s'.repeat(43)}` } }
            : {}),
        });
        expect(response.statusCode, url).toBe(authenticated ? 200 : 401);
      }
    },
  );

  it('enforces the member-role mutation HTTP boundary', async () => {
    const changeWorkspaceMemberRole = vi.fn().mockResolvedValue({
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      role: 'operator' as const,
      roleRevision: 2,
      changed: true,
      replayed: false,
    });
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: identityRuntime(
        vi.fn().mockResolvedValue(undefined),
        true,
        changeWorkspaceMemberRole,
      ),
    });
    await applicationFixture.application.init();
    const url =
      '/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/members/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/role';
    const cookie = `pertexo_session=${'s'.repeat(43)}`;
    const csrf = 'c'.repeat(32);
    const missingCsrf = await applicationFixture.application.inject({
      method: 'POST',
      url,
      headers: { cookie, 'idempotency-key': 'member-role' },
      payload: { role: 'operator', expectedRoleRevision: 1 },
    });
    expect(missingCsrf.statusCode).toBe(403);
    const invalid = await applicationFixture.application.inject({
      method: 'POST',
      url,
      headers: {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
        'idempotency-key': 'member-role',
      },
      payload: { role: 'operator', expectedRoleRevision: 1, extra: true },
    });
    expect(invalid.statusCode).toBe(400);
    const changed = await applicationFixture.application.inject({
      method: 'POST',
      url,
      headers: {
        cookie: `${cookie}; pertexo_csrf=${csrf}`,
        'x-csrf-token': csrf,
        'idempotency-key': 'member-role',
      },
      payload: { role: 'operator', expectedRoleRevision: 1 },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      role: 'operator',
      roleRevision: 2,
    });
    expect(changeWorkspaceMemberRole).toHaveBeenCalledOnce();
  });

  it('lists every integration', async () => {
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: identityRuntime(undefined, true),
    });
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/v1/integrations',
      headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          providerKey: 'email',
          operationKey: 'send_notification',
        },
        {
          providerKey: 'http',
          operationKey: 'request',
        },
        {
          providerKey: 'slack',
          operationKey: 'send_message',
        },
      ],
    });
  });

  it('rejects unsupported catalog query fields with problem details', async () => {
    applicationFixture.application = await createTestApiApplication(config, {
      ...dependencies(),
      identityRuntime: identityRuntime(undefined, true),
    });
    await applicationFixture.application.init();
    for (const route of ['node-definitions', 'integrations']) {
      const response = await applicationFixture.application.inject({
        method: 'GET',
        url: `/v1/${route}?arbitrary=value`,
        headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.json()).toMatchObject({ code: 'request.invalid' });
    }
  });
}
