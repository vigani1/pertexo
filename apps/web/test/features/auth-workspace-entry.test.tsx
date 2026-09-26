import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { createApiClient, type ApiClient } from '@/lib/api/client';
import { LoginPage } from '@/features/auth/login-page';
import { AccountMethodsSection } from '@/features/auth/components/account/account-methods-section';
import { endBrowserSession } from '@/features/auth/session-actions';
import { mockServer } from '../support/mock-server';
import { renderApp, testFetch } from '../support/render-app';
import { renderInRouter } from '../support/render-in-router';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  revision: 1,
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: ['workspace:read', 'workspace:manage'],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

function problem(status: number, code: string, title: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title,
      status,
      code,
      requestId: 'request-test-1234',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function authenticatedHandlers() {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [workspace], nextCursor: null }),
    ),
    http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/workflows`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({
        schemaVersion: 1,
        release: {
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        },
        items: [],
      }),
    ),
    http.get('http://pertexo.test/v1/integrations', () =>
      HttpResponse.json({
        schemaVersion: 1,
        release: {
          epoch: 1,
          fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        },
        items: [],
      }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
  ];
}

const passwordCapabilities = http.get(
  'http://pertexo.test/v1/auth/capabilities',
  () =>
    HttpResponse.json({
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: [],
    }),
);

const googleCapabilities = http.get(
  'http://pertexo.test/v1/auth/capabilities',
  () =>
    HttpResponse.json({
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: ['google'],
    }),
);

describe('authentication and workspace entry', () => {
  it('shows truthful outcomes for consumed, expired and first-stage email proofs', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    const invalid = renderApp('/login?error=verification_invalid');
    expect(
      await screen.findByText(
        /verification link is invalid, expired, or already used/u,
      ),
    ).toBeVisible();
    invalid.unmount();
    const pending = renderApp('/login?emailChangePending=true');
    expect(
      await screen.findByText(
        /Check your new address for the final verification link/u,
      ),
    ).toBeVisible();
    pending.unmount();
  });

  it('redirects an unauthenticated root visit to configured sign-in methods', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(await screen.findByLabelText('Password')).toBeVisible();
  });

  it('starts OIDC once and hands the validated provider URL to navigation', async () => {
    mockServer.use(
      googleCapabilities,
      http.post('*/v1/auth/sign-in/social', () =>
        HttpResponse.json({
          url: 'https://identity.example.test/authorize?state=safe',
          redirect: true,
        }),
      ),
    );
    const navigate = vi.fn();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    renderInRouter(
      <LoginPage apiClient={apiClient} navigateToProvider={navigate} />,
    );
    const continueButton = await screen.findByRole('button', {
      name: 'Continue with Google',
    });
    await userEvent.setup().click(continueButton);
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        'https://identity.example.test/authorize?state=safe',
      );
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(continueButton).toBeDisabled();
  });

  it('shows the Pertexo pending treatment while password sign-in is unresolved', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      passwordCapabilities,
      http.post('*/v1/auth/sign-in/email', async () => {
        await gate;
        return HttpResponse.json({ redirect: false, token: null, user });
      }),
    );
    const onAuthenticated = vi.fn();
    const { container } = renderInRouter(
      <LoginPage
        apiClient={createApiClient({
          fetch: testFetch,
          readCsrfToken: () => undefined,
        })}
        onAuthenticated={onAuthenticated}
      />,
    );
    const interaction = userEvent.setup();
    await interaction.type(
      await screen.findByLabelText('Email'),
      'operator@example.test',
    );
    await interaction.type(
      screen.getByLabelText('Password'),
      'correct horse battery staple',
    );
    await interaction.click(screen.getByRole('button', { name: 'Sign in' }));

    const pendingButton = screen.getByRole('button', { name: 'Signing in…' });
    expect(pendingButton).toBeDisabled();
    expect(
      pendingButton.querySelector('[data-slot="loading-orb"]'),
    ).toHaveAttribute('aria-hidden', 'true');
    const lens = container.querySelector('[data-slot="auth-lens"]');
    expect(lens).toHaveClass('live-edge');
    expect(lens).toHaveAttribute('aria-busy', 'true');

    release?.();
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalledTimes(1);
    });
  });

  it('does not follow a provider start response after the sign-in page unmounts', async () => {
    mockServer.use(googleCapabilities);
    let release: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchIgnoringAbort: typeof fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/v1/auth/sign-in/social')) return delayed;
      return testFetch(input, init);
    };
    const apiClient = createApiClient({
      fetch: fetchIgnoringAbort,
      readCsrfToken: () => undefined,
    });
    const navigate = vi.fn();
    const page = renderInRouter(
      <LoginPage apiClient={apiClient} navigateToProvider={navigate} />,
    );
    await userEvent
      .setup()
      .click(
        await screen.findByRole('button', { name: 'Continue with Google' }),
      );
    page.unmount();
    release?.(
      Response.json({ url: 'https://identity.example.test/authorize' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not follow an account-link response after its identity scope ends', async () => {
    let release: ((value: { authorizationUrl: string }) => void) | undefined;
    const delayed = new Promise<{ authorizationUrl: string }>((resolve) => {
      release = resolve;
    });
    const request = vi.fn().mockReturnValue(delayed);
    const apiClient = { request } as unknown as ApiClient;
    const navigate = vi.fn();
    const security = {
      email: 'operator@example.test',
      emailVerified: true,
      availableProviders: ['google' as const],
      methods: [
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          kind: 'password' as const,
          provider: null,
        },
      ],
    };
    const page = renderInRouter(
      <AccountMethodsSection
        apiClient={apiClient}
        userId={userId}
        security={security}
        navigateToProvider={navigate}
      />,
    );
    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Add a sign-in method',
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Add a sign-in method',
    });
    await userEvent
      .setup()
      .click(
        within(dialog).getByRole('button', { name: 'Continue to Google' }),
      );
    expect(within(dialog).getByLabelText('Current password')).toHaveFocus();
    expect(request).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .type(
        within(dialog).getByLabelText('Current password'),
        'correct horse battery staple',
      );
    await userEvent
      .setup()
      .click(
        within(dialog).getByRole('button', { name: 'Continue to Google' }),
      );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/account-security/methods/link/start',
        body: {
          provider: 'google',
          existingMethod: {
            kind: 'password',
            password: 'correct horse battery staple',
          },
        },
      }),
    );
    page.unmount();
    release?.({ authorizationUrl: 'https://identity.example.test/authorize' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps login recovery inline when the identity provider cannot start', async () => {
    mockServer.use(
      googleCapabilities,
      http.post('*/v1/auth/sign-in/social', () =>
        problem(503, 'provider.unavailable', 'Identity service unavailable'),
      ),
    );
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    renderInRouter(
      <LoginPage apiClient={apiClient} navigateToProvider={vi.fn()} />,
    );

    await userEvent
      .setup()
      .click(
        await screen.findByRole('button', { name: 'Continue with Google' }),
      );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google sign-in is unavailable right now',
    );
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toBeEnabled();
  });

  it('refuses a provider redirect with an unsafe scheme', async () => {
    mockServer.use(
      googleCapabilities,
      http.post('*/v1/auth/sign-in/social', () =>
        HttpResponse.json({
          url: 'javascript:alert(1)',
          redirect: true,
        }),
      ),
    );
    const navigate = vi.fn();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    renderInRouter(
      <LoginPage apiClient={apiClient} navigateToProvider={navigate} />,
    );

    await userEvent
      .setup()
      .click(
        await screen.findByRole('button', { name: 'Continue with Google' }),
      );

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('retires a pending reset when the same route selects a different token', async () => {
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseResponse: (() => void) | undefined;
    const responseMayComplete = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    mockServer.use(
      passwordCapabilities,
      http.post(
        'http://pertexo.test/v1/auth/account-security/password/reset',
        async ({ request }) => {
          const body = (await request.json()) as { token: string };
          expect(body.token).toBe('old-token');
          markRequestStarted?.();
          await responseMayComplete;
          return HttpResponse.json({ status: true });
        },
      ),
    );
    const app = renderApp('/reset-password?token=old-token');
    await userEvent
      .setup()
      .type(
        await screen.findByLabelText('New password'),
        'a sufficiently long password',
      );
    await userEvent
      .setup()
      .type(
        screen.getByLabelText('Confirm new password'),
        'a sufficiently long password',
      );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Reset password' }));
    await requestStarted;
    await app.router.navigate({
      to: '/reset-password',
      search: { token: 'new-token' },
    });
    releaseResponse?.();
    expect(await screen.findByLabelText('New password')).toHaveValue('');
    expect(
      screen.queryByRole('heading', { name: 'Password changed' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reset password' }),
    ).toBeEnabled();
  });

  it('distinguishes a rejected reset link from a lost completion response', async () => {
    mockServer.use(
      passwordCapabilities,
      http.post(
        'http://pertexo.test/v1/auth/account-security/password/reset',
        () =>
          problem(
            400,
            'auth.reset_link_invalid',
            'Reset link invalid or expired',
          ),
      ),
    );
    const app = renderApp('/reset-password?token=one-time-token');
    const passwordInput = await screen.findByLabelText('New password');
    await userEvent.setup().type(passwordInput, 'new secure password value');
    await userEvent
      .setup()
      .type(
        screen.getByLabelText('Confirm new password'),
        'new secure password value',
      );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Reset password' }));
    // A refused link can't be fixed from the form: the page says so and
    // offers the one way on.
    expect(
      await screen.findByRole('heading', {
        name: 'This reset link has expired',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Request a new link' }),
    ).toHaveAttribute('href', '/forgot-password');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
    expect(passwordInput).not.toBeInTheDocument();
    app.unmount();

    mockServer.use(
      http.post(
        'http://pertexo.test/v1/auth/account-security/password/reset',
        () => HttpResponse.error(),
      ),
    );
    renderApp('/reset-password?token=another-token');
    const secondPassword = await screen.findByLabelText('New password');
    await userEvent
      .setup()
      .type(secondPassword, 'another secure password value');
    await userEvent
      .setup()
      .type(
        screen.getByLabelText('Confirm new password'),
        'another secure password value',
      );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Reset password' }));
    expect(
      await screen.findByText(/Your password may have changed/u),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Try signing in' })).toBeVisible();
    expect(secondPassword).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('sends a fresh verification link from an expired link without resubmitting credentials', async () => {
    let signupCalls = 0;
    const addresses: string[] = [];
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
      http.post('http://pertexo.test/v1/auth/sign-up/email', () => {
        signupCalls += 1;
        return HttpResponse.json({ user: null });
      }),
      http.post(
        'http://pertexo.test/v1/auth/send-verification-email',
        async ({ request }) => {
          addresses.push(((await request.json()) as { email: string }).email);
          return HttpResponse.json({ status: true });
        },
      ),
    );
    const app = renderApp('/login?error=verification_invalid');
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Send a new link' }),
    );
    await actor.type(screen.getByLabelText('Email'), 'operator@example.test');
    await actor.click(screen.getByRole('button', { name: 'Send link' }));
    expect(
      await screen.findByRole('heading', { name: 'Verify your email' }),
    ).toBeVisible();
    expect(screen.getByText('operator@example.test')).toBeVisible();
    expect(screen.getByRole('button', { name: /Resend in/u })).toBeDisabled();
    expect(addresses).toEqual(['operator@example.test']);
    app.unmount();

    renderApp('/login?error=verification_invalid');
    await actor.click(
      await screen.findByRole('button', { name: 'Send a new link' }),
    );
    expect(screen.getByLabelText('Email')).toHaveValue('');
    await actor.type(screen.getByLabelText('Email'), 'operator@example.test');
    await actor.click(screen.getByRole('button', { name: 'Send link' }));
    await waitFor(() => {
      expect(addresses).toHaveLength(2);
    });
    expect(signupCalls).toBe(0);
  });

  it('marks only local resend validation as a field error', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
      http.post('http://pertexo.test/v1/auth/send-verification-email', () =>
        problem(503, 'auth.unavailable', 'Identity service unavailable'),
      ),
    );
    renderApp('/login?error=verification_invalid');
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Send a new link' }),
    );
    const send = screen.getByRole('button', { name: 'Send link' });
    await actor.click(send);
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveFocus();
    await actor.type(email, 'operator@example.test');
    expect(email).not.toHaveAttribute('aria-invalid', 'true');
    await actor.click(send);
    expect(await screen.findByText(/couldn’t send the email/u)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /couldn’t send the email/u,
    );
    expect(email).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('does not offer password signup or recovery on direct routes when disabled', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/auth/capabilities', () =>
        HttpResponse.json({
          password: {
            enabled: false,
            minimumLength: 12,
            verificationRequired: true,
          },
          socialProviders: [],
        }),
      ),
    );
    const app = renderApp('/sign-up');
    expect(
      await screen.findByText('Password sign-up is not available right now.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Create account' }),
    ).not.toBeInTheDocument();
    await app.router.navigate({ to: '/forgot-password' });
    expect(
      await screen.findByText('Password recovery is not available right now.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Send reset link' }),
    ).not.toBeInTheDocument();
    await app.router.navigate({
      to: '/reset-password',
      search: { token: 'valid-looking-token' },
    });
    expect(
      await screen.findByText('Password reset is not available right now.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Reset password' }),
    ).not.toBeInTheDocument();
  });

  it('lists server-authorized workspaces and enters one through a URL-owned scope', async () => {
    mockServer.use(...authenticatedHandlers());
    const app = renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/,
    });
    await userEvent.setup().click(entry);
    const [spine] = await screen.findAllByRole('navigation', {
      name: 'Workspace',
    });
    if (spine === undefined) throw new Error('Missing workspace navigation');
    expect(
      await within(spine).findByRole('link', { name: 'Home' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(app.router.state.location.pathname).toBe(`/w/${workspaceId}`);
    expect(
      within(spine).queryByRole('link', { name: /connections/iu }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: `Account menu for ${user.displayName}`,
      }),
    ).toBeVisible();
  });

  it('clears protected Query data when the authenticated account changes', async () => {
    mockServer.use(...authenticatedHandlers());
    const app = renderApp('/workspaces');
    expect(await screen.findByText(user.email)).toBeVisible();
    app.queryClient.setQueryData(['protected', userId], { secret: 'user-a' });
    const nextUser = {
      ...user,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      email: 'next@example.test',
    };
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(nextUser),
      ),
    );
    await app.router.invalidate();
    expect(await screen.findByText(nextUser.email)).toBeVisible();
    expect(app.queryClient.getQueryData(['protected', userId])).toBeUndefined();
  });

  it('removes cached protected rows after authoritative authentication loss', async () => {
    mockServer.use(...authenticatedHandlers(), passwordCapabilities);
    const app = renderApp('/workspaces');
    expect(await screen.findByText(user.email)).toBeVisible();
    app.queryClient.setQueryData(['protected', userId], { secret: 'user-a' });
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    await app.router.invalidate();
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(app.queryClient.getQueryData(['protected', userId])).toBeUndefined();
  });

  it('manages token-free account sessions and rotates a password with session CSRF', async () => {
    const secondSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    let passwordChanged = false;
    let emailChangeRequested = false;
    let revokedSession: string | undefined;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: [],
          methods: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              kind: 'password',
              provider: null,
            },
          ],
        }),
      ),
      http.get('http://pertexo.test/v1/auth/account-security/sessions', () =>
        HttpResponse.json({
          items: [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              current: true,
              createdAt: '2026-09-22T10:00:00.000Z',
              updatedAt: '2026-09-22T11:00:00.000Z',
              expiresAt: '2026-09-29T10:00:00.000Z',
              ipAddress: null,
              userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            },
            ...(revokedSession === secondSessionId
              ? []
              : [
                  {
                    id: secondSessionId,
                    current: false,
                    createdAt: '2026-09-21T10:00:00.000Z',
                    updatedAt: '2026-09-21T11:00:00.000Z',
                    expiresAt: '2026-09-28T10:00:00.000Z',
                    ipAddress: '192.0.2.10',
                    userAgent:
                      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
                  },
                ]),
          ],
        }),
      ),
      http.post(
        'http://pertexo.test/v1/auth/account-security/sessions/revoke',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          const body = (await request.json()) as { sessionId: string };
          revokedSession = body.sessionId;
          return HttpResponse.json({ revoked: true });
        },
      ),
      http.post(
        'http://pertexo.test/v1/auth/account-security/password/change',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          const body = (await request.json()) as {
            currentPassword: string;
            newPassword: string;
          };
          expect(body).toEqual({
            currentPassword: 'current secure password',
            newPassword: 'replacement secure password',
          });
          passwordChanged = true;
          return HttpResponse.json({ changed: true });
        },
      ),
      http.post(
        'http://pertexo.test/v1/auth/change-email',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBe(
            'csrf-token-for-component-tests-12345678901234567890',
          );
          expect(await request.json()).toEqual({
            newEmail: 'new.operator@example.test',
            callbackURL: '/login?emailChanged=true',
          });
          emailChangeRequested = true;
          return HttpResponse.json({ status: true });
        },
      ),
    );

    renderApp('/account/security', { strict: true });
    expect(
      await screen.findByRole('heading', { name: 'Account & security' }),
    ).toBeVisible();
    const actor = userEvent.setup();
    await actor.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(await screen.findByText('Firefox on Windows')).toBeVisible();
    expect(screen.getByText('Chrome on macOS')).toBeVisible();
    expect(screen.getByText('This device')).toBeVisible();
    expect(screen.getByText('192.0.2.10')).toBeVisible();
    expect(screen.queryByText(/Mozilla/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/pertexo_session/iu)).not.toBeInTheDocument();

    const signOutOther = () =>
      screen.getByRole('button', { name: 'Sign out Firefox on Windows' });
    await actor.click(signOutOther());
    expect(revokedSession).toBeUndefined();
    await actor.click(
      within(screen.getByRole('dialog', { name: /\?$/u })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    expect(revokedSession).toBeUndefined();
    await actor.click(signOutOther());
    await actor.click(
      within(screen.getByRole('dialog', { name: /\?$/u })).getByRole('button', {
        name: 'Sign out',
      }),
    );
    await waitFor(() => {
      expect(revokedSession).toBe(secondSessionId);
    });
    await waitFor(() => {
      expect(screen.queryByText('Firefox on Windows')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText('Signed out of Firefox on Windows'),
    ).toBeVisible();

    await actor.click(screen.getByRole('tab', { name: 'Sign-in & security' }));
    await actor.type(
      await screen.findByLabelText('Current password'),
      'current secure password',
    );
    await actor.type(
      screen.getByLabelText('New password'),
      'replacement secure password',
    );
    await actor.type(
      screen.getByLabelText('Confirm new password'),
      'replacement secure password',
    );
    await actor.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(passwordChanged).toBe(true);
    });
    expect(await screen.findByText('Password changed')).toBeVisible();
    expect(screen.getByLabelText('Current password')).toHaveValue('');

    await actor.click(screen.getByRole('tab', { name: 'Profile' }));
    expect(await screen.findByText('Verified')).toBeVisible();
    await actor.type(
      screen.getByLabelText('New email'),
      'new.operator@example.test',
    );
    await actor.click(screen.getByRole('button', { name: 'Change email' }));
    await waitFor(() => {
      expect(emailChangeRequested).toBe(true);
    });
    expect(await screen.findByText(/Check your current inbox/u)).toBeVisible();
  }, 15_000);

  it('asks for a fresh sign-in when an email change needs one', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: [],
          methods: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              kind: 'password',
              provider: null,
            },
          ],
        }),
      ),
      http.post('http://pertexo.test/v1/auth/change-email', () =>
        problem(403, 'auth.forbidden', 'Forbidden'),
      ),
    );
    renderApp('/account/security');
    const actor = userEvent.setup();
    const email = await screen.findByLabelText('New email');
    await actor.type(email, user.email);
    await actor.click(screen.getByRole('button', { name: 'Change email' }));
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/That’s your current email/u)).toBeVisible();
    await actor.clear(email);
    await actor.type(email, 'new.operator@example.test');
    await actor.click(screen.getByRole('button', { name: 'Change email' }));
    expect(
      await screen.findByText(/For your security, sign in again/u),
    ).toBeVisible();
    // The fresh sign-in comes back to this page.
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/logout?returnTo=%2Faccount%2Fsecurity',
    );
  });

  it('shows truthful linking return feedback alongside authoritative methods', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: ['google'],
          methods: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              kind: 'password',
              provider: null,
            },
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              kind: 'social',
              provider: 'google',
            },
          ],
        }),
      ),
      http.get('http://pertexo.test/v1/auth/account-security/sessions', () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderApp('/account/security?linked=true');
    expect(
      await screen.findByText(/You’re back from the provider/u),
    ).toBeVisible();
    expect(await screen.findByText('Google')).toBeVisible();
    expect(
      screen.queryByText(/was linked successfully/iu),
    ).not.toBeInTheDocument();
  });

  it('requires confirmation before removing a sign-in method', async () => {
    const socialMethodId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    let removedMethod: string | undefined;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/auth/account-security', () =>
        HttpResponse.json({
          email: user.email,
          emailVerified: true,
          availableProviders: ['google'],
          methods: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              kind: 'password',
              provider: null,
            },
            ...(removedMethod === socialMethodId
              ? []
              : [{ id: socialMethodId, kind: 'social', provider: 'google' }]),
          ],
        }),
      ),
      http.get('http://pertexo.test/v1/auth/account-security/sessions', () =>
        HttpResponse.json({ items: [] }),
      ),
      http.post(
        'http://pertexo.test/v1/auth/account-security/methods/unlink',
        async ({ request }) => {
          const body = (await request.json()) as { methodId: string };
          removedMethod = body.methodId;
          return HttpResponse.json({ unlinked: true });
        },
      ),
    );
    renderApp('/account/security');
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('tab', { name: 'Sign-in & security' }),
    );
    const removeSocial = () =>
      screen.getByRole('button', { name: 'Remove Google' });
    await screen.findByText('Google');
    await actor.click(removeSocial());
    const confirmation = screen.getByRole('dialog', {
      name: 'Remove sign-in method?',
    });
    expect(
      within(confirmation).getByText(/Other devices will be signed out/u),
    ).toBeVisible();
    expect(removedMethod).toBeUndefined();
    await actor.click(
      within(confirmation).getByRole('button', { name: 'Keep method' }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    expect(removedMethod).toBeUndefined();
    await actor.click(removeSocial());
    await actor.click(
      within(screen.getByRole('dialog', { name: /\?$/u })).getByRole('button', {
        name: 'Remove method',
      }),
    );
    await waitFor(() => {
      expect(removedMethod).toBe(socialMethodId);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Remove Google' }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /\?$/u }),
      ).not.toBeInTheDocument();
    });
    // The last way in has no Remove at all, just the reason.
    expect(
      screen.queryByRole('button', { name: 'Remove Password' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Your only way to sign in')).toBeVisible();
  });

  it('routes an eligible pending-deletion workspace to lifecycle recovery', async () => {
    const recoverableWorkspace = {
      ...workspace,
      status: 'pending_deletion',
    };
    mockServer.use(...authenticatedHandlers());
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [recoverableWorkspace], nextCursor: null }),
      ),
    );
    const app = renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/u,
    });
    expect(entry).toBeEnabled();
    expect(entry).toHaveTextContent('Restore');
    await userEvent.setup().click(entry);
    expect(
      await screen.findByRole('heading', { name: 'Workspace' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/settings`,
    );
  });

  it('does not expose pending-deletion recovery without manage capability', async () => {
    const deniedWorkspace = {
      ...workspace,
      status: 'pending_deletion',
      revision: 1,
      role: 'viewer',
      capabilities: ['workspace:read'],
    };
    mockServer.use(...authenticatedHandlers());
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [deniedWorkspace], nextCursor: null }),
      ),
    );
    renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/u,
    });
    expect(entry).toBeDisabled();
    expect(entry).toHaveTextContent('Being deleted');
  });

  it('keeps suspended workspaces unavailable even for managers', async () => {
    mockServer.use(...authenticatedHandlers());
    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [{ ...workspace, status: 'suspended' }],
          nextCursor: null,
        }),
      ),
    );
    renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/u,
    });
    expect(entry).toBeDisabled();
    expect(entry).toHaveTextContent('Suspended');
  });

  it('opens the mobile More sheet and returns focus after Escape', async () => {
    mockServer.use(...authenticatedHandlers());
    renderApp(`/w/${workspaceId}/workflows`);
    await screen.findByRole('heading', { name: 'Workflows' });
    const trigger = screen.getByRole('button', { name: 'More' });

    await userEvent.setup().click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    expect(within(sheet).getByRole('link', { name: 'Settings' })).toBeVisible();

    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'More' }),
      ).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('offers first-workspace creation from the no-membership state', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp('/workspaces');
    expect(
      await screen.findByRole('heading', { name: 'Create your workspace' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Workspace name')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Create workspace' }),
    ).toBeVisible();
  });

  it('shows route-level recovery when workspace discovery fails', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        problem(503, 'service.unavailable', 'Workspace service unavailable'),
      ),
    );
    renderApp('/workspaces');

    expect(
      await screen.findByRole('heading', {
        name: 'Something broke on our side',
      }),
    ).toBeVisible();

    mockServer.use(
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [workspace], nextCursor: null }),
      ),
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Workspaces' }),
    ).toBeVisible();
  });

  it('rejects an inaccessible deep link without switching to unrelated data', async () => {
    mockServer.use(...authenticatedHandlers());
    const unavailableId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const app = renderApp(`/w/${unavailableId}/workflows`);
    expect(
      await screen.findByRole('heading', {
        name: 'This workspace isn’t available',
      }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${unavailableId}/workflows`,
    );
  });

  it('verifies the session before classifying an invalid workspace deep link', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    renderApp('/w/not-a-workspace/workflows');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', {
        name: 'This workspace isn’t available',
      }),
    ).not.toBeInTheDocument();
  });

  it('cancels scoped reads and clears cached identity data after confirmed logout', async () => {
    let queryCanceled = false;
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/auth/logout',
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    });
    const lateRead = queryClient
      .query({
        queryKey: ['identity', userId, 'late'],
        queryFn: ({ signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                queryCanceled = true;
                reject(
                  new Error('Scoped query canceled', { cause: signal.reason }),
                );
              },
              { once: true },
            );
          }),
      })
      .catch((error: unknown) => error);
    queryClient.setQueryData(['identity', 'current-user'], user);

    await endBrowserSession(apiClient, queryClient);

    await lateRead;
    expect(queryCanceled).toBe(true);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('runs the loader-free logout route once in StrictMode and preserves caches for a deliberate retry', async () => {
    let logoutRequests = 0;
    let workspaceReads = 0;
    let signedOut = false;
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        signedOut
          ? problem(401, 'auth.unauthenticated', 'Authentication required')
          : HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () => {
        workspaceReads += 1;
        return problem(
          503,
          'service.unavailable',
          'Workspace service unavailable',
        );
      }),
      http.post('http://pertexo.test/v1/auth/logout', () => {
        logoutRequests += 1;
        if (logoutRequests === 1)
          return problem(503, 'service.unavailable', 'Logout unavailable');
        signedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const app = renderApp('/logout', { strict: true });
    app.queryClient.setQueryData(['protected', 'sentinel'], 'preserved');

    expect(
      await screen.findByRole('heading', {
        name: 'Sign-out didn’t finish',
      }),
    ).toBeVisible();
    expect(logoutRequests).toBe(1);
    expect(workspaceReads).toBe(0);
    expect(app.queryClient.getQueryData(['protected', 'sentinel'])).toBe(
      'preserved',
    );

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(logoutRequests).toBe(2);
    expect(workspaceReads).toBe(0);
    expect(
      app.queryClient.getQueryData(['protected', 'sentinel']),
    ).toBeUndefined();
  });
});
