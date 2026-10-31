import { HttpResponse, http } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { LoginPage } from '@/features/auth/pages/login';
import { SignUpPage } from '@/features/auth/pages/sign-up';
import { loginNoticeFrom } from '@/features/auth/model/login-notice';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import { renderInRouter } from '../../support/render-in-router';

function installAnswers(signUp: 'open' | 'invitation') {
  mockServer.use(
    http.get('http://pertexo.test/v1/auth/capabilities', () =>
      HttpResponse.json({
        password: {
          enabled: true,
          minimumLength: 12,
          verificationRequired: true,
        },
        socialProviders: [],
        signUp,
      }),
    ),
  );
}

function apiClient() {
  return createApiClient({ fetch: testFetch, readCsrfToken: () => undefined });
}

const INVITATION = '/invitations/accept';

describe('sign-in and sign-up on an install', () => {
  it('offers an account when sign-up is open', async () => {
    installAnswers('open');
    renderInRouter(<LoginPage apiClient={apiClient()} />);
    expect(
      await screen.findByRole('link', { name: 'Create an account' }),
    ).toBeInTheDocument();
  });

  it('says to ask for an invitation when sign-up is closed', async () => {
    installAnswers('invitation');
    renderInRouter(<LoginPage apiClient={apiClient()} />);
    expect(
      await screen.findByText(/Ask someone in your workspace/u),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Create an account' }),
    ).toBeNull();
  });

  it('keeps the way to an account for someone following an invitation', async () => {
    installAnswers('invitation');
    renderInRouter(<LoginPage apiClient={apiClient()} returnTo={INVITATION} />);
    expect(
      await screen.findByRole('link', { name: 'Create an account' }),
    ).toBeInTheDocument();
  });

  it('shows no form on the sign-up page when sign-up is closed', async () => {
    installAnswers('invitation');
    renderInRouter(<SignUpPage apiClient={apiClient()} />);
    expect(
      await screen.findByRole('heading', { name: /by invitation/u }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the form to someone following an invitation', async () => {
    installAnswers('invitation');
    renderInRouter(
      <SignUpPage apiClient={apiClient()} returnTo={INVITATION} />,
    );
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('explains a verification link that arrived after sign-up closed', () => {
    expect(loginNoticeFrom({ signUpClosed: true })?.text).toMatch(
      /by invitation/u,
    );
  });

  it('explains in words when the server refuses a sign-up', async () => {
    installAnswers('invitation');
    mockServer.use(
      http.post('*/v1/auth/sign-up/email', () =>
        HttpResponse.json(
          {
            type: 'urn:pertexo:problem:auth.sign_up_closed',
            title: 'Sign-up is by invitation',
            status: 403,
            code: 'auth.sign_up_closed',
            requestId: 'request-closed-sign-up',
          },
          {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );
    renderInRouter(
      <SignUpPage apiClient={apiClient()} returnTo={INVITATION} />,
    );
    const actor = userEvent.setup();
    await actor.type(await screen.findByLabelText('Name'), 'Someone');
    await actor.type(screen.getByLabelText('Email'), 'someone@example.test');
    await actor.type(
      screen.getByLabelText('Password'),
      'a long enough password',
    );
    await actor.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByText(/New accounts here are by invitation/u),
    ).toBeInTheDocument();
  });
});
