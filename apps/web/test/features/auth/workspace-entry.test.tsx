import { AccountMethodsSection } from '@/features/auth/components/account/methods-section';

import { LoginPage } from '@/features/auth/pages/login';

import { createApiClient, type ApiClient } from '@/lib/api/client';

import { act, screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../support/mock-server';

import {
  expectSignInPage,
  renderApp,
  testFetch,
} from '../../support/render-app';

import { renderInRouter } from '../../support/render-in-router';

import { getRequestUrl } from '../../support/request';

import {
  googleCapabilities,
  passwordCapabilities,
  problem,
  user,
  userId,
} from './workspace-entry/fixture';

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
    await expectSignInPage();
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
      const url = getRequestUrl(input);
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
    await act(async () => {
      release?.(
        Response.json({
          url: 'https://identity.example.test/authorize',
          redirect: true,
        }),
      );
      await delayed;
    });
    expect(navigate).not.toHaveBeenCalled();
  });
  it('does not follow an account-link response after its identity scope ends', async () => {
    let release: ((value: { authorizationUrl: string }) => void) | undefined;
    const delayed = new Promise<{ authorizationUrl: string }>((resolve) => {
      release = resolve;
    });
    const request = vi.fn().mockReturnValue(delayed);
    const apiClient = {
      stream: vi.fn(),
      download: vi.fn(),
      request,
    } satisfies ApiClient;
    const navigate = vi.fn();
    const security = {
      email: 'operator@example.test',
      emailVerified: true,
      availableProviders: ['google' as const],
      twoFactor: { enabled: false, recoveryCodesRemaining: null },
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
    await act(async () => {
      release?.({
        authorizationUrl: 'https://identity.example.test/authorize',
      });
      await delayed;
    });
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
});
