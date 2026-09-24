import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createQueryClient } from '@/app/query-client';
import { createApiClient, type ApiClient } from '@/lib/api/client';
import { LoginPage } from '@/features/auth/login-page';
import { AccountMethodsSection } from '@/features/auth/components/account-methods-section';
import { endBrowserSession } from '@/features/auth/session-actions';
import { mockServer } from '../support/mock-server';
import { renderApp, testFetch } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
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
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LoginPage apiClient={apiClient} navigateToProvider={navigate} />
      </QueryClientProvider>,
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
    const { container } = render(
      <QueryClientProvider client={createQueryClient()}>
        <LoginPage
          apiClient={createApiClient({
            fetch: testFetch,
            readCsrfToken: () => undefined,
          })}
          onAuthenticated={onAuthenticated}
        />
      </QueryClientProvider>,
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
    expect(
      container.querySelector('[data-slot="aurora-border"]'),
    ).toHaveAttribute('aria-hidden', 'true');

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
    const page = render(
      <QueryClientProvider client={createQueryClient()}>
        <LoginPage apiClient={apiClient} navigateToProvider={navigate} />
      </QueryClientProvider>,
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
    const page = render(
      <QueryClientProvider client={createQueryClient()}>
        <AccountMethodsSection
          apiClient={apiClient}
          userId={userId}
          security={security}
          navigateToProvider={navigate}
        />
      </QueryClientProvider>,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Link Google' }));
    await userEvent
      .setup()
      .type(
        screen.getByLabelText('Current password'),
        'correct horse battery staple',
      );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Continue to provider' }));
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
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LoginPage apiClient={apiClient} navigateToProvider={vi.fn()} />
      </QueryClientProvider>,
    );

    await userEvent
      .setup()
      .click(
        await screen.findByRole('button', { name: 'Continue with Google' }),
      );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Identity service unavailable',
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
    const queryClient = createQueryClient();
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LoginPage apiClient={apiClient} navigateToProvider={navigate} />
      </QueryClientProvider>,
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
      .click(screen.getByRole('button', { name: 'Reset password' }));
    await requestStarted;
    await app.router.navigate({
      to: '/reset-password',
      search: { token: 'new-token' },
    });
    releaseResponse?.();
    expect(await screen.findByLabelText('New password')).toHaveValue('');
    expect(
      screen.queryByText(/Your password has been reset/u),
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
      .click(screen.getByRole('button', { name: 'Reset password' }));
    expect(
      await screen.findByText(
        'This reset link is invalid or expired. Request a new one.',
      ),
    ).toBeVisible();
    expect(passwordInput).not.toHaveAttribute('aria-invalid', 'true');
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
      .click(screen.getByRole('button', { name: 'Reset password' }));
    expect(
      await screen.findByText(/Your password may have changed/u),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Try signing in' })).toBeVisible();
    expect(secondPassword).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('resumes verification mail from a fresh signup page without resubmitting credentials', async () => {
    let signupCalls = 0;
    const addresses: string[] = [];
    mockServer.use(
      passwordCapabilities,
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
    const app = renderApp('/sign-up');
    await userEvent
      .setup()
      .type(
        await screen.findByLabelText('Need another verification link?'),
        'operator@example.test',
      );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Resend verification email' }));
    expect(
      await screen.findByText(/If this address needs verification/u),
    ).toBeVisible();
    expect(
      screen.getByText(/If this address needs verification/u),
    ).toHaveAttribute('role', 'status');
    expect(
      screen.queryByLabelText('Need another verification link?'),
    ).not.toBeInTheDocument();
    expect(addresses).toEqual(['operator@example.test']);
    expect(signupCalls).toBe(0);
    app.unmount();

    renderApp('/sign-up');
    expect(
      await screen.findByLabelText('Need another verification link?'),
    ).toHaveValue('');
    await userEvent
      .setup()
      .type(
        screen.getByLabelText('Need another verification link?'),
        'operator@example.test',
      );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() => {
      expect(addresses).toHaveLength(2);
    });
    expect(signupCalls).toBe(0);
  });

  it('marks only local resend validation as a field error', async () => {
    mockServer.use(
      passwordCapabilities,
      http.post('http://pertexo.test/v1/auth/send-verification-email', () =>
        problem(503, 'auth.unavailable', 'Identity service unavailable'),
      ),
    );
    renderApp('/sign-up');
    const resend = await screen.findByRole('button', {
      name: 'Resend verification email',
    });
    await userEvent.setup().click(resend);
    expect(
      screen.getByLabelText('Need another verification link?'),
    ).toHaveAttribute('aria-invalid', 'true');
    await userEvent
      .setup()
      .type(
        screen.getByLabelText('Need another verification link?'),
        'operator@example.test',
      );
    expect(
      screen.getByLabelText('Need another verification link?'),
    ).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.setup().click(resend);
    expect(
      await screen.findByText(/The response was lost or delayed/u),
    ).toHaveAttribute('role', 'alert');
    expect(
      screen.getByLabelText('Need another verification link?'),
    ).not.toHaveAttribute('aria-invalid', 'true');
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
    expect(
      await screen.findByRole('heading', { name: 'Workflows' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/workflows`,
    );
    const navigation = screen.getByRole('navigation', {
      name: 'Workspace navigation',
    });
    expect(
      within(navigation).getByRole('link', { name: 'Workflows' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(navigation).queryByText(/connections/iu),
    ).not.toBeInTheDocument();
    expect(screen.getByText(user.email)).toBeVisible();
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
              userAgent: 'Current browser',
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
                    userAgent: 'Other browser',
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
      await screen.findByRole('heading', { name: 'Account security' }),
    ).toBeVisible();
    expect(await screen.findByText('Other browser')).toBeVisible();
    expect(screen.queryByText(/pertexo_session/iu)).not.toBeInTheDocument();

    const actor = userEvent.setup();
    await actor.click(screen.getByRole('button', { name: 'End session' }));
    expect(revokedSession).toBeUndefined();
    await actor.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Keep sessions',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(revokedSession).toBeUndefined();
    await actor.click(screen.getByRole('button', { name: 'End session' }));
    await actor.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'End sessions',
      }),
    );
    await waitFor(() => {
      expect(revokedSession).toBe(secondSessionId);
    });
    await waitFor(() => {
      expect(screen.queryByText('Other browser')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await actor.type(
      screen.getByLabelText('Current password'),
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
    expect(await screen.findByText(/Password updated/u)).toBeVisible();

    await actor.type(
      screen.getByLabelText('New email'),
      'new.operator@example.test',
    );
    await actor.click(screen.getByRole('button', { name: 'Change email' }));
    await waitFor(() => {
      expect(emailChangeRequested).toBe(true);
    });
    expect(await screen.findByText(/Check your current email/u)).toBeVisible();
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
      await screen.findByText(/Provider verification returned/u),
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
    const removeSocial = () => {
      const button = screen.getAllByRole('button', { name: 'Remove' })[1];
      if (button === undefined)
        throw new Error('Social method action is missing');
      return button;
    };
    await screen.findByText('Google');
    await actor.click(removeSocial());
    const confirmation = screen.getByRole('dialog');
    expect(
      within(confirmation).getByText(/Other browser sessions will end/u),
    ).toBeVisible();
    expect(removedMethod).toBeUndefined();
    await actor.click(
      within(confirmation).getByRole('button', { name: 'Keep method' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(removedMethod).toBeUndefined();
    await actor.click(removeSocial());
    await actor.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Remove method',
      }),
    );
    await waitFor(() => {
      expect(removedMethod).toBe(socialMethodId);
    });
    await waitFor(() => {
      expect(screen.queryByText('Google')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
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
    expect(entry).toHaveTextContent('Open recovery');
    await userEvent.setup().click(entry);
    expect(
      await screen.findByRole('heading', { name: 'General' }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${workspaceId}/settings/general`,
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
    expect(entry).toHaveTextContent('Deletion pending');
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

  it('traps mobile navigation focus and returns it after Escape', async () => {
    mockServer.use(...authenticatedHandlers());
    renderApp(`/w/${workspaceId}/workflows`);
    await screen.findByRole('heading', { name: 'Workflows' });
    const trigger = screen.getByRole('button', { name: 'Open navigation' });

    await userEvent.setup().click(trigger);
    const drawer = await screen.findByRole('dialog', {
      name: 'Workspace navigation',
    });
    expect(
      within(drawer).getByRole('link', { name: 'Workflows' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        within(drawer).getByRole('button', { name: 'Close navigation' }),
      ).toHaveFocus();
    });

    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Workspace navigation' }),
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
    expect(
      screen.getByRole('button', { name: 'Create your first workspace' }),
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
        name: 'Pertexo could not load this screen',
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
        name: 'This workspace is not available',
      }),
    ).toBeVisible();
    expect(app.router.state.location.pathname).toBe(
      `/w/${unavailableId}/workflows`,
    );
  });

  it('verifies the session before classifying an invalid workspace deep link', async () => {
    mockServer.use(
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
        name: 'This workspace is not available',
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
        name: 'Sign out did not complete',
      }),
    ).toBeVisible();
    expect(logoutRequests).toBe(1);
    expect(workspaceReads).toBe(0);
    expect(app.queryClient.getQueryData(['protected', 'sentinel'])).toBe(
      'preserved',
    );

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry sign out' }));
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
