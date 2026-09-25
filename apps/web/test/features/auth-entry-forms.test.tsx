import { HttpResponse, http } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { LegacyMigrationPage } from '@/features/auth/legacy-migration-page';
import { LoginPage } from '@/features/auth/login-page';
import { mockServer } from '../support/mock-server';
import { renderApp, testFetch } from '../support/render-app';
import { renderInRouter } from '../support/render-in-router';

function capabilities(
  options: Readonly<{
    minimumLength?: number;
    socialProviders?: readonly string[];
    legacyMigrationAvailable?: boolean;
  }> = {},
) {
  return http.get('http://pertexo.test/v1/auth/capabilities', () =>
    HttpResponse.json({
      password: {
        enabled: true,
        minimumLength: options.minimumLength ?? 12,
        verificationRequired: true,
      },
      socialProviders: options.socialProviders ?? [],
      legacyMigrationAvailable: options.legacyMigrationAvailable ?? false,
    }),
  );
}

function problem(
  status: number,
  code: string,
  headers: Readonly<Record<string, string>> = {},
) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title: 'Problem',
      status,
      code,
      requestId: 'request-entry-forms',
    },
    {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    },
  );
}

const signedOut = http.get('http://pertexo.test/v1/users/me', () =>
  problem(401, 'auth.unauthenticated'),
);

function apiClient() {
  return createApiClient({ fetch: testFetch, readCsrfToken: () => undefined });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sign-in family forms', () => {
  it('counts down from Retry-After before sign-in is allowed again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempts = 0;
    mockServer.use(
      capabilities(),
      http.post('*/v1/auth/sign-in/email', () => {
        attempts += 1;
        return problem(429, 'request.rate_limited', { 'retry-after': '3' });
      }),
    );
    renderInRouter(<LoginPage apiClient={apiClient()} />);
    const actor = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await actor.type(
      await screen.findByLabelText('Email'),
      'operator@example.test',
    );
    await actor.type(screen.getByLabelText('Password'), 'a password');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));

    const waiting = await screen.findByRole('button', {
      name: /Try again in 0:0[23]/u,
    });
    expect(waiting).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Too many attempts/u);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(attempts).toBe(1);
  });

  it('turns an unverified sign-in into a resend with a cooldown', async () => {
    const resent: string[] = [];
    mockServer.use(
      capabilities(),
      http.post('*/v1/auth/sign-in/email', () =>
        problem(403, 'auth.email_not_verified'),
      ),
      http.post('*/v1/auth/send-verification-email', async ({ request }) => {
        resent.push(((await request.json()) as { email: string }).email);
        return HttpResponse.json({ status: true });
      }),
    );
    renderInRouter(<LoginPage apiClient={apiClient()} />);
    const actor = userEvent.setup();
    await actor.type(await screen.findByLabelText('Email'), 'new@example.test');
    await actor.type(screen.getByLabelText('Password'), 'a password');
    await actor.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: 'Verify your email' }),
    ).toBeVisible();
    expect(screen.getByText('new@example.test')).toBeVisible();
    await actor.click(screen.getByRole('button', { name: 'Resend link' }));
    expect(await screen.findByText(/Sent\./u)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Resend in 1:00|Resend in 0:59/u }),
    ).toBeDisabled();
    expect(resent).toEqual(['new@example.test']);

    await actor.click(
      screen.getByRole('button', { name: 'Use another email' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toHaveValue('');
  });

  it('checks sign-up fields on submit, clears them as they’re fixed, and fills the meter to the server minimum', async () => {
    mockServer.use(signedOut, capabilities({ minimumLength: 10 }));
    renderApp('/sign-up');
    const actor = userEvent.setup();
    const name = await screen.findByLabelText('Your name');
    await actor.click(name);
    await actor.tab();
    // Moving through the form says nothing yet.
    expect(name).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText(/Add your name/u)).not.toBeInTheDocument();

    const email = screen.getByLabelText('Email');
    await actor.type(email, 'ada@northwind');
    await actor.click(screen.getByRole('button', { name: 'Create account' }));
    expect(name).toHaveFocus();
    expect(screen.getByText(/Add your name/u)).toBeVisible();
    expect(screen.getByText(/missing the end of the domain/u)).toBeVisible();

    await actor.type(name, 'Ada');
    expect(name).toHaveAttribute('aria-invalid', 'false');
    await actor.type(email, '.dev');
    expect(email).toHaveAttribute('aria-invalid', 'false');

    const password = screen.getByLabelText('Password');
    const meter = () => document.querySelector('[data-slot="password-meter"]');
    await actor.type(password, 'woven-t');
    expect(meter()).toHaveAttribute('data-state', 'short');
    expect(meter()).toHaveTextContent('7 / 10');
    await actor.type(password, 'hr');
    expect(meter()).toHaveAttribute('data-state', 'short');
    await actor.type(password, 'e');
    expect(meter()).toHaveAttribute('data-state', 'met');
    expect(meter()).toHaveTextContent('10 / 10');
    expect(password).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('sign-up-password-meter'),
    );
  });

  it('shows the inbox after sign-up, with a resend cooldown and a way to start over', async () => {
    let signUps = 0;
    mockServer.use(
      signedOut,
      capabilities(),
      http.post('*/v1/auth/sign-up/email', async ({ request }) => {
        signUps += 1;
        expect(await request.json()).toMatchObject({
          name: 'Ada Lovelace',
          email: 'ada@northwind.dev',
          password: 'a long enough password',
        });
        return HttpResponse.json({ user: null });
      }),
    );
    renderApp('/sign-up');
    const actor = userEvent.setup();
    await actor.type(await screen.findByLabelText('Your name'), 'Ada Lovelace');
    await actor.type(screen.getByLabelText('Email'), 'ada@northwind.dev');
    await actor.type(
      screen.getByLabelText('Password'),
      'a long enough password',
    );
    await actor.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByRole('heading', { name: 'Check your inbox' }),
    ).toBeVisible();
    expect(screen.getByText('ada@northwind.dev')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Resend in (1:00|0:59)/u }),
    ).toBeDisabled();
    expect(screen.queryByLabelText(/verification link/iu)).toBeNull();
    await actor.click(screen.getByRole('button', { name: 'Start over' }));
    expect(
      await screen.findByRole('heading', { name: 'Create your account' }),
    ).toBeVisible();
    expect(signUps).toBe(1);
  });

  it('answers a recovery request neutrally and throttles asking again', async () => {
    mockServer.use(
      signedOut,
      capabilities(),
      http.post('*/v1/auth/request-password-reset', () =>
        HttpResponse.json({ status: true }),
      ),
    );
    renderApp('/forgot-password');
    const actor = userEvent.setup();
    await actor.type(
      await screen.findByLabelText('Email'),
      'unknown@example.test',
    );
    await actor.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account exists for/u)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Resend in (1:00|0:59)/u }),
    ).toBeDisabled();
  });

  it('requires a matching confirmation before resetting a password', async () => {
    let resets = 0;
    mockServer.use(
      signedOut,
      capabilities(),
      http.post('*/v1/auth/account-security/password/reset', () => {
        resets += 1;
        return HttpResponse.json({ status: true });
      }),
    );
    renderApp('/reset-password?token=one-time-token');
    const actor = userEvent.setup();
    await actor.type(
      await screen.findByLabelText('New password'),
      'a new secure password',
    );
    await actor.type(
      screen.getByLabelText('Confirm new password'),
      'a different password',
    );
    await actor.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(screen.getByLabelText('Confirm new password')).toHaveFocus();
    expect(screen.getByText('The passwords don’t match.')).toBeVisible();
    expect(resets).toBe(0);

    await actor.clear(screen.getByLabelText('Confirm new password'));
    await actor.type(
      screen.getByLabelText('Confirm new password'),
      'a new secure password',
    );
    await actor.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(
      await screen.findByRole('heading', { name: 'Password changed' }),
    ).toBeVisible();
    expect(
      screen.getByText(/signed you out on every other device/u),
    ).toBeVisible();
    expect(resets).toBe(1);
  });

  it('explains an incomplete reset link without a form', async () => {
    mockServer.use(signedOut, capabilities());
    renderApp('/reset-password');
    expect(
      await screen.findByRole('heading', { name: 'This link is incomplete' }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Request a new one' }),
    ).toHaveAttribute('href', '/forgot-password');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('shows the five-minute window after choosing a new method and closes it when time runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockServer.use(
      capabilities({
        socialProviders: ['google'],
        legacyMigrationAvailable: true,
      }),
      http.post('*/v1/auth/legacy-migration/start', () =>
        HttpResponse.json({
          authorizationUrl: 'https://legacy.example.test/authorize?state=s',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      ),
    );
    const navigate = vi.fn();
    renderInRouter(
      <LegacyMigrationPage
        apiClient={apiClient()}
        navigateToProvider={navigate}
      />,
    );
    const actor = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await actor.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    );
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(
      await within(steps).findByText('Confirm your old account'),
    ).toBeVisible();
    expect(screen.getByText(/^(5:00|4:59)$/u)).toBeVisible();
    await actor.click(
      screen.getByRole('button', { name: 'Continue to your old sign-in' }),
    );
    expect(navigate).toHaveBeenCalledWith(
      'https://legacy.example.test/authorize?state=s',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    });
    await waitFor(() => {
      expect(screen.getByText(/5-minute window closed/u)).toBeVisible();
    });
  });
});
