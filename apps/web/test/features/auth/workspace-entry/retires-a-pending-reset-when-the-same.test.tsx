import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { expectSignInPage, renderApp } from '../../../support/render-app';

import {
  authenticatedHandlers,
  passwordCapabilities,
  problem,
  user,
  userId,
  workspaceId,
} from './fixture';

describe('authentication and workspace entry', () => {
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
    await expectSignInPage();
    expect(app.queryClient.getQueryData(['protected', userId])).toBeUndefined();
  });
});
